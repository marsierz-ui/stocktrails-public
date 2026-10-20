(function () {
  // Imported broker transactions, kept in this browser only. IndexedDB of the
  // extension (or PWA) origin: content scripts on finance portals run in the
  // portal's origin and cannot open it, unlike chrome.storage.local, which
  // content.js already reads. Nothing here is synced or exported with the JSON
  // backup.
  //
  // Every record is keyed by owner (the signed-in account id), so a second
  // account on the same browser never sees the first one's trades.
  // Version 2 adds "commitments": the rules the user adopted from the coach
  // (what they are, when, with which setting). Derived from the user's own trades
  // and kept next to them: device-only, per owner, cleared with them.
  // Version 3 adds "agent": the paper decisions of the two agents (rules and AI), each
  // saved once when first made and never overwritten, so a decision's decidedAt shows
  // whether it was made live or after the fact.
  // Version 4 adds "checks": every run of "Check a buy before you place it" with what was
  // typed, what was measured and what the rules and the AI agent answered, kept for later
  // evaluation. Device-only like the rest; one record per run, the AI agent's answer added to it.
  // Version 5 adds "reruns": the AI agent's recent moments decided again by the text model and by the decision model, side
  // by side, for evaluating the two. Decided after the fact, so never part of the agents' record or portfolios.
  const DB = "stocktrails_ledger", VER = 5;
  const STORES = ["tx", "links", "imports", "commitments", "agent", "checks", "reruns"];

  function openDB() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () {
        const db = r.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "key" }).createIndex("owner", "owner");
        });
      };
      r.onsuccess = function () {
        // Let a newer version of this database replace this connection, so an open tab never blocks an update.
        r.result.onversionchange = function () { r.result.close(); };
        res(r.result);
      };
      r.onblocked = function () { rej(new Error("Another Stocktrails tab holds the old local database. Close it and reload.")); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function byOwner(store, owner) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const rq = db.transaction(store, "readonly").objectStore(store).index("owner").getAll(owner);
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }

  function putAll(store, recs) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(store, "readwrite"), os = tx.objectStore(store);
        recs.forEach(function (r) { os.put(r); });
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function txKey(owner, t) { return owner + "|" + t.broker + "|" + t.extId; }

  // Adds parsed transactions; ones already stored (same broker id) are left
  // as they are, so importing an overlapping or the same file twice is safe.
  async function addTxs(owner, txs, importId) {
    const have = {};
    (await byOwner("tx", owner)).forEach(function (r) { have[r.key] = 1; });
    const fresh = [];
    txs.forEach(function (t) {
      const key = txKey(owner, t);
      if (have[key]) return;
      have[key] = 1;
      fresh.push(Object.assign({ key: key, owner: owner, importId: importId }, t));
    });
    await putAll("tx", fresh);
    return { added: fresh.length, duplicates: txs.length - fresh.length };
  }

  function getTxs(owner) {
    return byOwner("tx", owner).then(function (rows) { return rows.sort(function (a, b) { return a.ts - b.ts; }); });
  }

  // links: instrument key (ISIN, or SYM:<symbol>) -> matched stock + status.
  async function getLinks(owner) {
    const m = {};
    (await byOwner("links", owner)).forEach(function (r) { m[r.inst] = r; });
    return m;
  }
  function putLinks(owner, links) {
    return putAll("links", links.map(function (l) { return Object.assign({}, l, { key: owner + "|" + l.inst, owner: owner }); }));
  }

  function getImports(owner) {
    return byOwner("imports", owner).then(function (rows) { return rows.sort(function (a, b) { return b.at - a.at; }); });
  }
  function addImport(owner, summary) {
    return putAll("imports", [Object.assign({}, summary, { key: owner + "|" + summary.id, owner: owner })]);
  }

  // Adopted rules, newest first. Each: { id, ruleId, params, text, adoptedAt, status, ... }.
  function getCommitments(owner) {
    return byOwner("commitments", owner).then(function (rows) { return rows.sort(function (a, b) { return b.adoptedAt - a.adoptedAt; }); });
  }
  function putCommitments(owner, list) {
    return putAll("commitments", list.map(function (c) { return Object.assign({}, c, { key: owner + "|" + c.id, owner: owner }); }));
  }
  function deleteCommitment(owner, id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction("commitments", "readwrite");
        tx.objectStore("commitments").delete(owner + "|" + id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  // Paper decisions: { id (candidate id), agent: "ai"|"rules", kind, ticker, t, action, days, size,
  // reason, rules, model, provider, promptVersion, decidedAt }. Only ids not saved yet are
  // written: a decision is kept as it was first made. Returns the number added.
  function agentKey(owner, d) { return owner + "|" + d.agent + "|" + d.id; }
  function getAgentDecisions(owner) { return byOwner("agent", owner); }
  // Removes saved decisions of one agent by candidate id; used only to re-ask a moment that is still inside the 2-day live window
  // after the meaning of a size changed (see trAgentMigrateSizes), never to change what was decided about an older moment.
  function deleteAgentDecisions(owner, agent, ids) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction("agent", "readwrite"), os = tx.objectStore("agent");
        ids.forEach(function (id) { os.delete(owner + "|" + agent + "|" + id); });
        tx.oncomplete = function () { res(ids.length); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  async function putAgentDecisions(owner, list) {
    const have = {};
    (await byOwner("agent", owner)).forEach(function (r) { have[r.key] = 1; });
    const fresh = [];
    list.forEach(function (d) {
      const key = agentKey(owner, d);
      if (have[key]) return;
      have[key] = 1;
      fresh.push(Object.assign({}, d, { key: key, owner: owner }));
    });
    if (fresh.length) await putAll("agent", fresh);
    return fresh.length;
  }

  // A moment decided again (the live verdict on stock pages, issue #30): the earlier answer is kept under its own id
  // (`kept`, see ATAgentSession.supersededCopy) and the new one takes the moment's id, in one transaction.
  function supersedeAgentDecision(owner, kept, next) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction("agent", "readwrite"), os = tx.objectStore("agent");
        os.put(Object.assign({}, kept, { key: agentKey(owner, kept), owner: owner }));
        os.put(Object.assign({}, next, { key: agentKey(owner, next), owner: owner }));
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  // Pre-trade checks: { ts, ticker, amount, currency, measured, adopted, hits, unknown, size, rulesAgent, ai, ... }.
  // putCheck saves a run and returns its key; updateCheck merges fields into a saved run (the AI agent's answer).
  function getChecks(owner) { return byOwner("checks", owner); }
  async function putCheck(owner, rec) {
    const key = owner + "|" + rec.ts + "|" + rec.ticker;
    await putAll("checks", [Object.assign({}, rec, { key: key, owner: owner })]);
    return key;
  }
  function updateCheck(owner, key, patch) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction("checks", "readwrite"), os = tx.objectStore("checks"), rq = os.get(key);
        rq.onsuccess = function () { if (rq.result && rq.result.owner === owner) os.put(Object.assign({}, rq.result, patch)); };
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  // Model comparison runs: { runId, at, engine: "text"|"decision", id (the moment's id), kind, ticker, t, action, days, size, reason,
  // reasoning, trace, deferred, model, provider, promptVersion, input, ms, error? }. One record per run, engine and moment.
  function getReruns(owner) { return byOwner("reruns", owner); }
  function putReruns(owner, list) {
    return putAll("reruns", list.map(function (r) { return Object.assign({}, r, { key: owner + "|" + r.runId + "|" + r.engine + "|" + r.id, owner: owner }); }));
  }
  // Drops every saved comparison run of this account (the agents' own record is not touched).
  async function clearReruns(owner) {
    const db = await openDB();
    await new Promise(function (res, rej) {
      const tx = db.transaction("reruns", "readwrite"), rq = tx.objectStore("reruns").index("owner").openCursor(IDBKeyRange.only(owner));
      rq.onsuccess = function () { const c = rq.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  // Removes everything one account imported (trades, matches, import log), the rules adopted from it, the agents' paper decisions and the saved checks.
  async function clearOwner(owner) {
    const db = await openDB();
    await Promise.all(STORES.map(function (s) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(s, "readwrite"), idx = tx.objectStore(s).index("owner");
        const rq = idx.openCursor(IDBKeyRange.only(owner));
        rq.onsuccess = function () { const c = rq.result; if (c) { c.delete(); c.continue(); } };
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    }));
  }

  // Removes one import batch and the trades it added.
  async function removeImport(owner, importId) {
    const db = await openDB();
    await new Promise(function (res, rej) {
      const tx = db.transaction(["tx", "imports"], "readwrite");
      const rq = tx.objectStore("tx").index("owner").openCursor(IDBKeyRange.only(owner));
      rq.onsuccess = function () {
        const c = rq.result;
        if (!c) return;
        if (c.value.importId === importId) c.delete();
        c.continue();
      };
      tx.objectStore("imports").delete(owner + "|" + importId);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  const api = { addTxs, getTxs, getLinks, putLinks, getImports, addImport, clearOwner, removeImport, getCommitments, putCommitments, deleteCommitment, getAgentDecisions, putAgentDecisions, deleteAgentDecisions, supersedeAgentDecision, getChecks, putCheck, updateCheck, getReruns, putReruns, clearReruns };
  if (typeof self !== "undefined") self.ATLedgerDB = api;
})();
