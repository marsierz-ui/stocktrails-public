# Stocktrails - Privacy Policy

The policy users read and accept is [dashboard/privacy.html](../dashboard/privacy.html),
together with the Terms of Use, [dashboard/terms.html](../dashboard/terms.html).
Both ship inside the extension (so the sign-in page links work offline) and are
published with the web app, which gives the public URLs the Chrome Web Store needs:

- Privacy Policy: https://marsierz-ui.github.io/attention-tracker/dashboard/privacy.html
- Terms of Use: https://marsierz-ui.github.io/attention-tracker/dashboard/terms.html

Edit the HTML files, not this one. When a change adds a new use of personal data,
raise `TERMS_VERSION` in `src/aiclient.js`: every signed-in user is then asked to
accept the new version before the app opens (`askTerms` in dashboard/dashboard.js).

The operator (GDPR Art. 13 controller) is named in both files: Marek Szczęsny,
Frankfurt am Main, Germany. Change it in both when a holding company takes over.
