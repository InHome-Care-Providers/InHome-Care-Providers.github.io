# IHCP Appointment API — Azure Deployment Guide

> Deploys the Version 2 `index.js` Function App on a **new Azure subscription**, writing appointment form submissions to a SharePoint Microsoft List via Microsoft Graph.

---

## Prerequisites

- An Azure account with an active subscription (even a free trial works)
- A Microsoft 365 tenant with SharePoint Online (the IHCP SharePoint site)
- Global Admin or Application Administrator role in Entra ID (to create the app registration)
- SharePoint Site Owner or Admin on the target site (to create the list)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed locally (optional but recommended), or use the Azure Portal Cloud Shell

---

## Step 1 — Create a Resource Group

Everything lives in one resource group for easy management.

1. Go to **portal.azure.com** → search **Resource groups** → **+ Create**
2. Fill in:
   - **Subscription**: your new subscription
   - **Resource group name**: `rg-ihcp-prod` (or whatever naming convention you prefer)
   - **Region**: `East US` (closest to Atlanta; pick what makes sense for your users)
3. Click **Review + create** → **Create**

---

## Step 2 — Register an App in Entra ID

This gives the Function App a service principal identity to call Microsoft Graph.

1. Go to **portal.azure.com** → search **App registrations** → **+ New registration**
2. Fill in:
   - **Name**: `IHCP-Appointment-API`
   - **Supported account types**: *Accounts in this organizational directory only (Single tenant)*
   - **Redirect URI**: leave blank (not needed for client credentials)
3. Click **Register**

### 2a — Note the IDs

On the app's **Overview** page, copy and save:
- **Application (client) ID** → this is your `CLIENT_ID`
- **Directory (tenant) ID** → this is your `TENANT_ID`

### 2b — Create a Client Secret

1. Left nav → **Certificates & secrets** → **+ New client secret**
2. Description: `ihcp-appt-api-secret`
3. Expiry: pick 12 or 24 months (set a calendar reminder to rotate before expiry)
4. Click **Add**
5. **Copy the Value immediately** — it won't be shown again. This is your `CLIENT_SECRET`

### 2c — Grant Microsoft Graph API Permission

1. Left nav → **API permissions** → **+ Add a permission**
2. Select **Microsoft Graph** → **Application permissions**
3. Search for and select: **`Sites.Selected`**
   - This is the least-privilege option — it only grants access to specific SharePoint sites you explicitly authorize
   - If `Sites.Selected` is too complex for now, you can use **`Sites.ReadWrite.All`** instead, but `Sites.Selected` is the better long-term choice
4. Click **Add permissions**
5. Click **Grant admin consent for [your tenant]** → confirm **Yes**
6. Verify the status column shows a green checkmark ("Granted for...")

### 2d — (If using Sites.Selected) Authorize the specific SharePoint site

This step is only needed if you chose `Sites.Selected` above. You'll use Microsoft Graph Explorer or a PowerShell script to grant the app read-write access to your specific IHCP SharePoint site.

**Option A — Graph Explorer (quick)**:

1. Go to [Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer)
2. Sign in with your admin account
3. Run a POST to: `https://graph.microsoft.com/v1.0/sites/{SITE_ID}/permissions`
4. Body:
```json
{
  "roles": ["write"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "YOUR_CLIENT_ID",
        "displayName": "IHCP-Appointment-API"
      }
    }
  ]
}
```

**Option B — PowerShell**:
```powershell
# Install module if needed
Install-Module Microsoft.Graph -Scope CurrentUser

Connect-MgGraph -Scopes "Sites.FullControl.All"

$params = @{
    roles = @("write")
    grantedToIdentities = @(
        @{
            application = @{
                id = "YOUR_CLIENT_ID"
                displayName = "IHCP-Appointment-API"
            }
        }
    )
}

New-MgSitePermission -SiteId "YOUR_SITE_ID" -BodyParameter $params
```

---

## Step 3 — Get Your SharePoint Site ID

You need the full site ID string for the `SITE_ID` environment variable.

1. Open a browser and navigate to:
   ```
   https://graph.microsoft.com/v1.0/sites/{your-tenant}.sharepoint.com:/sites/{your-site-name}?$select=id
   ```
   Replace `{your-tenant}` with your M365 tenant name and `{your-site-name}` with the SharePoint site URL slug.

2. Or use **Graph Explorer**: GET `https://graph.microsoft.com/v1.0/sites/root` to find your tenant's root, then query your specific site.

3. The `id` value looks like: `contoso.sharepoint.com,xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx,yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy`

4. Save this — it's your `SITE_ID`

---

## Step 4 — Create the SharePoint List

1. Go to your IHCP SharePoint site
2. Click **+ New** → **List** → **Blank list**
3. Name: `Appointment Requests` (or whatever you prefer)
4. Add columns exactly matching these internal names and types:

| Column Display Name | Internal Name   | Type                         | Notes                              |
|---------------------|-----------------|------------------------------|------------------------------------|
| Title               | Title           | Single line of text          | Already exists by default          |
| SubmittedAt         | SubmittedAt     | Date and time                | Include time = Yes                 |
| SourcePage          | SourcePage      | Single line of text          |                                    |
| FirstName           | FirstName       | Single line of text          |                                    |
| LastName            | LastName        | Single line of text          |                                    |
| DateOfBirth         | DateOfBirth     | Single line of text          | Text, NOT Date (avoids TZ issues)  |
| Phone               | Phone           | Single line of text          |                                    |
| Email               | Email           | Single line of text          |                                    |
| StreetAddress       | StreetAddress   | Single line of text          |                                    |
| City                | City            | Single line of text          |                                    |
| State               | State           | Single line of text          |                                    |
| Zip                 | Zip             | Single line of text          |                                    |
| PreferredDate       | PreferredDate   | Single line of text          | Text to preserve user input exactly|
| PreferredTime       | PreferredTime   | Single line of text          |                                    |
| Notes               | Notes           | Multiple lines of text       | Plain text mode                    |
| Consent             | Consent         | Yes/No                       |                                    |
| UserAgent           | UserAgent       | Multiple lines of text       | Plain text mode (optional)         |
| ClientIP            | ClientIP        | Single line of text          | Optional                           |

**Important — Internal names**: SharePoint auto-generates internal names when you create columns. If you name a column "First Name" (with a space), the internal name becomes `First_x0020_Name`, which won't match the function code. To get clean internal names:

- **Method 1**: Create each column with no spaces first (e.g., `FirstName`), then rename the display name afterward if you want it prettier in the list view.
- **Method 2**: Create via the SharePoint REST API or site script to control internal names directly.

### 4a — Get the List ID

1. On your SharePoint list, click the **gear icon** ⚙️ → **List settings**
2. Look at the URL — the list GUID is in the query string parameter, e.g.:
   ```
   .../_layouts/15/listedit.aspx?List=%7Babcdef12-3456-7890-abcd-ef1234567890%7D
   ```
3. Decode the `%7B` / `%7D` (curly braces): `abcdef12-3456-7890-abcd-ef1234567890`
4. Save this — it's your `LIST_ID`

---

## Step 5 — Create the Function App in Azure

### 5a — Create a Storage Account (required by Functions)

1. Search **Storage accounts** → **+ Create**
2. Fill in:
   - **Resource group**: `rg-ihcp-prod`
   - **Storage account name**: `stihcpapptfunc` (must be globally unique, lowercase, no hyphens)
   - **Region**: same as your resource group
   - **Performance**: Standard
   - **Redundancy**: LRS (locally redundant — cheapest, fine for function state)
3. **Review + create** → **Create**

### 5b — Create the Function App

1. Search **Function App** → **+ Create** → choose **Consumption** plan (pay-per-execution, essentially free at low volume)
2. Fill in:
   - **Resource group**: `rg-ihcp-prod`
   - **Function App name**: `ihcp-appt-api` (must be globally unique — this becomes `ihcp-appt-api.azurewebsites.net`)
   - **Runtime stack**: **Node.js**
   - **Version**: **20 LTS**
   - **Region**: same as above
   - **Storage account**: select the one you just created
3. On the **Hosting** tab: Operating System = **Linux** (or Windows, both work for Node)
4. **Review + create** → **Create**
5. Wait for deployment to complete

---

## Step 6 — Configure Application Settings

1. Go to your Function App → left nav → **Environment variables** (under Settings)
2. Add each of these as app settings:

| Name                | Value                                                        |
|---------------------|--------------------------------------------------------------|
| `TENANT_ID`         | Your directory (tenant) ID from Step 2a                      |
| `CLIENT_ID`         | Your application (client) ID from Step 2a                    |
| `CLIENT_SECRET`     | Your client secret value from Step 2b                        |
| `SITE_ID`           | Full SharePoint site ID string from Step 3                   |
| `LIST_ID`           | SharePoint list GUID from Step 4a                            |
| `ALLOWED_ORIGIN`    | `https://inhome-care-providers.github.io,https://www.inhomecareproviders.org` |
| `FORM_SHARED_SECRET`| Generate a random string (e.g., run `openssl rand -hex 32`)  |

3. Click **Apply** → **Confirm**

> The `ALLOWED_ORIGIN` value should be a comma-separated list of every domain your frontend will be served from. Include both the GitHub Pages URL and any custom domains.

---

## Step 7 — Deploy the Function Code

You have several options here. Pick whichever fits your workflow:

### Option A — Deploy via VS Code (recommended for first time)

1. Install the **Azure Functions** extension for VS Code
2. Create a local project folder with this structure:
   ```
   ihcp-appt-api/
   ├── host.json
   ├── package.json          (optional, only if you add npm dependencies)
   ├── submit/
   │   ├── index.js          ← your Version 2 code
   │   └── function.json
   ```

3. **host.json**:
   ```json
   {
     "version": "2.0",
     "logging": {
       "applicationInsights": {
         "samplingSettings": {
           "isEnabled": true,
           "excludedTypes": "Request"
         }
       }
     },
     "extensionBundle": {
       "id": "Microsoft.Azure.Functions.ExtensionBundle",
       "version": "[4.*, 5.0.0)"
     }
   }
   ```

4. **submit/function.json**:
   ```json
   {
     "bindings": [
       {
         "authLevel": "anonymous",
         "type": "httpTrigger",
         "direction": "in",
         "name": "req",
         "methods": ["get", "post", "options"]
       },
       {
         "type": "http",
         "direction": "out",
         "name": "res"
       }
     ]
   }
   ```

5. **submit/index.js**: paste in your Version 2 code (the file attached to this conversation)

6. In VS Code, open the Azure panel → Functions → click the deploy ↑ icon → select your `ihcp-appt-api` Function App → confirm

### Option B — Deploy via Azure CLI

```bash
# Login
az login

# Set subscription
az account set --subscription "YOUR_SUBSCRIPTION_NAME_OR_ID"

# Navigate to your project folder
cd ihcp-appt-api/

# Deploy (zip deploy)
func azure functionapp publish ihcp-appt-api
```

> Requires [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-tools) installed locally (`npm install -g azure-functions-core-tools@4`).

### Option C — Deploy via Portal (quick and dirty)

1. In the portal, go to your Function App → **Functions** → **+ Create**
2. Template: **HTTP trigger**
3. Name: `submit`
4. Authorization level: **Anonymous**
5. Click **Create**, then go into the function → **Code + Test**
6. Paste your `index.js` code into the editor
7. Also check `function.json` matches the bindings above
8. Click **Save**

---

## Step 8 — Get the Function URL

1. Go to Function App → **Functions** → click `submit`
2. Click **Get Function URL** at the top
3. Copy the URL — it will look like:
   ```
   https://ihcp-appt-api.azurewebsites.net/api/submit
   ```
4. This is the URL you'll set as `APPT_FUNCTION_URL` in your `IHCP_Hard_Launch.html` frontend code

---

## Step 9 — Update the Frontend HTML

In your `IHCP_Hard_Launch.html`, update these two JavaScript constants to point at the new function:

```javascript
const APPT_FUNCTION_URL = "https://ihcp-appt-api.azurewebsites.net/api/submit";
const APPT_FORM_SECRET  = "your-generated-secret-from-step-6";
```

Make sure `APPT_FORM_SECRET` matches the `FORM_SHARED_SECRET` value you set in the Function App's environment variables.

---

## Step 10 — Test End-to-End

### 10a — Quick test with curl

```bash
curl -X POST https://ihcp-appt-api.azurewebsites.net/api/submit \
  -H "Content-Type: application/json" \
  -H "Origin: https://inhome-care-providers.github.io" \
  -H "X-Form-Secret: your-generated-secret" \
  -d '{
    "answers": {
      "first_name": "Test",
      "last_name": "User",
      "dob": "1990-01-15",
      "phone": "555-123-4567",
      "email": "test@example.com",
      "street_address": "123 Test St",
      "city": "Atlanta",
      "state": "GA",
      "zip": "30301",
      "preferred_date": "2026-05-01",
      "preferred_time": "Morning",
      "notes": "This is a test submission",
      "consent": true
    },
    "sourcePage": "/test"
  }'
```

Expected response: `{"ok": true, "id": "..."}`

### 10b — Verify in SharePoint

Go to your SharePoint list and confirm the test row appeared with all fields populated correctly.

### 10c — Test from the actual website

1. Push the updated `IHCP_Hard_Launch.html` to GitHub Pages
2. Open the site, fill out the appointment form, and submit
3. Check the SharePoint list for the new entry
4. Check browser DevTools Network tab — the POST should return 200 with `{"ok": true}`

### 10d — Test error cases

- Submit from an unauthorized origin (should get 403)
- Submit with wrong `X-Form-Secret` (should get 401)
- Submit with empty/missing fields (should get 400)

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| CORS error in browser console | `ALLOWED_ORIGIN` doesn't include your domain | Add domain to the comma-separated list in app settings |
| 401 Unauthorized | `X-Form-Secret` header doesn't match | Check the secret in both HTML and app settings |
| 500 "Token request failed" | Wrong `TENANT_ID`, `CLIENT_ID`, or `CLIENT_SECRET` | Double-check values in app settings; regenerate secret if expired |
| 500 "Access denied" from Graph | App registration missing permissions or admin consent | Re-check Step 2c; if using `Sites.Selected`, re-check Step 2d |
| 500 "Resource not found" from Graph | Wrong `SITE_ID` or `LIST_ID` | Re-verify both IDs from Steps 3 and 4a |
| 500 "Column not found" or field not saving | SharePoint internal column name mismatch | Check internal names via list settings URL or `_api/web/lists/getbytitle('...')/fields` |
| Function not triggering at all | Function might be stopped or deployment failed | Check Function App → Overview → Status = Running; check deployment logs |

---

## Post-Deployment Checklist

- [ ] Test submission works end-to-end (curl + browser)
- [ ] All 18 SharePoint columns populated correctly
- [ ] CORS blocks unauthorized origins
- [ ] Shared secret rejects bad values
- [ ] Set a calendar reminder to rotate `CLIENT_SECRET` before expiry
- [ ] Add origin debug logging from Version 1 if needed:
  ```javascript
  context.log(`Origin received="${origin}" AllowedOrigins="${allowedOrigins.join(" | ")}"`);
  ```
  (Add this right after the `echoOrigin` assignment in the main handler)
- [ ] Consider enabling **Application Insights** on the Function App for monitoring and alerting
