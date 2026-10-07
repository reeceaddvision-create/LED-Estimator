# LED Screen Estimator

Customers get an instant LED screen estimate, see the screen on a photo of their own site, and download a branded PDF. Their details and mockup land in the admin page.

| Address | What it is |
|---|---|
| `/` | The customer estimator |
| `/admin` | Admin: enquiries, screens and prices, extras, brand and wording |
| `/api/...` | Server part (login, saving, enquiries). Runs on Netlify. |

## One-time setup on Netlify

1. New project from this GitHub repository (no build command, publish folder is set by `netlify.toml`).
2. Project configuration → Environment variables:
   - `ADMIN_PASSWORD` = the admin password
   - `SESSION_SECRET` = any long random text (keep private, never put it in this repository)
3. Deploys → Trigger deploy.
4. Open `/admin`, log in, check prices, press **Save changes** once.

Prices in `public/default-config.json` are placeholders, used only until you first save in the admin page.
