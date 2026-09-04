# Setting up your Spotify app

Lineupify needs a Spotify **Client ID** from an app you own. Creating one is free and takes about two minutes. No client secret is needed: Lineupify logs in with OAuth PKCE, which is designed for apps that cannot keep a secret.

## Why you need your own app

Spotify puts every new app in **Development Mode**:

- at most 5 users per app (the owner plus up to 4 people added under *User Management*);
- the **app owner must have Spotify Premium**;
- production access ("Extended Quota Mode") is only granted to registered businesses with 250,000+ monthly active users.

A shared Lineupify app would therefore stop working after five people. So each user creates their own app and gives Lineupify the Client ID.

## Before you start

- A Spotify account with **Premium** for the account that will own the app. If you are on the free plan, see "Using a friend's app" below.
- If you already have a Spotify app for another tool, you can reuse it: skip to "Reusing an existing app".

## Step 1: Open the dashboard

Go to https://developer.spotify.com/dashboard and log in with your Spotify account. If this is your first visit you will be asked to accept the Developer Terms of Service.

## Step 2: Create the app

Click **Create app** and fill in the form:

| Field | Value |
|---|---|
| **App name** | Anything, for example `Lineupify`. |
| **App description** | Anything, for example `Festival lineup playlists`. |
| **Website** | Leave empty (optional). |
| **Redirect URIs** | `http://127.0.0.1:8765/callback` exactly, then click **Add** so it appears in the list below the field. |
| **Which API/SDKs are you planning to use?** | Tick **Web API**. |
| Terms checkbox | Tick "I understand and agree with Spotify's Developer Terms of Service and Design Guidelines". |

Click **Save**.

About the redirect URI:

- It must be `http://127.0.0.1:8765/callback` with the port. Spotify's documentation says a loopback URI may omit the port, but the dashboard rejects the port-less form as "not secure" (a known bug), so Lineupify listens on a fixed port instead.
- `http://localhost/callback` is **rejected** by Spotify. Use the IP form.
- Use `http`, not `https`, and no trailing slash.
- If port 8765 is taken on your machine, register `http://127.0.0.1:8888/callback` (any free port 1024-65535) instead and tell Lineupify the port: set `SPOTIFY_REDIRECT_PORT=8888` in the MCP config, or run `lineupify-mcp setup --port 8888`, or ask the assistant to call `setup` with `redirectPort: 8888`.

## Step 3: Copy the Client ID

After saving you land on the app's page. Click **Settings** (top right). Under **Basic Information** you will see:

- **Client ID**: a 32-character hex string. This is what Lineupify needs.
- **Client secret** (behind "View client secret"): **not needed**. Do not paste it anywhere.

Give the Client ID to Lineupify in one of these ways:

- In chat: "connect Lineupify to Spotify, my client ID is …". The assistant calls the `setup` tool, which stores it in `~/.lineupify/config.json`.
- Terminal: `npx -y lineupify-mcp setup --client-id <id>`
- MCP config: put it in the `env` block as `SPOTIFY_CLIENT_ID` (see [hosts.md](hosts.md)). An environment variable takes precedence over `config.json`.

## Step 4: Connect

Ask the assistant to call `connect`, or run `npx -y lineupify-mcp auth`. A browser tab opens on accounts.spotify.com. Make sure you are signed in as the app owner (or a user added under User Management), click **Agree**, and you will see "Connected to Spotify. Signed in as …". Close the tab and call `status` to confirm.

The login page stays valid for 5 minutes. If the browser did not open, `connect` and `status` both print the URL to open by hand.

Scopes requested: `playlist-modify-private`, `playlist-modify-public`, `user-top-read`, `user-follow-read`.

## Reusing an existing app

If you already created a Spotify app for another tool:

1. Open https://developer.spotify.com/dashboard, click the app, then **Settings**.
2. Under **Redirect URIs** add `http://127.0.0.1:8765/callback` (keep the other tool's URIs) and click **Add**, then **Save**.
3. Make sure **Web API** is ticked under "APIs used".
4. Copy the **Client ID** from Basic Information and give it to Lineupify as in Step 3.

The other tool keeps working; Lineupify only needs its own redirect URI in the list.

## Adding other users (User Management)

Development Mode apps only work for the owner and up to 4 named users. To let someone else log in with your app:

1. Open the app in the dashboard, then **Settings**, then the **User Management** tab.
2. Enter the person's **full name** and the **email address of their Spotify account**, then click **Add user**.
3. They can now install Lineupify, use *your* Client ID, and `connect` with their own Spotify account.

If a user is not listed here, every API call for them fails with HTTP 403 (`SPOTIFY_FORBIDDEN` in Lineupify).

## Using a friend's app (no Premium)

If you do not have Premium you cannot own a working app, but someone with Premium can add you under User Management on theirs. You then use their Client ID; the playlist is still created in **your** account, because you sign in as yourself during `connect`.

## "You have reached the app limit"

Spotify caps how many Development Mode apps one account can have. If the dashboard refuses to create a new app:

- Reuse one of your existing apps (see above); one app can serve several tools.
- Or delete an app you no longer use: open it, **Settings**, scroll to the bottom, **Delete**. Then create the new one.

## Checking that everything is right

Run `npx -y lineupify-mcp doctor`. It reports the Client ID source, the redirect URI you need to have registered, token age, and whether `GET /me` succeeds. In chat, `status` shows the same in one line.

Common mistakes:

| Symptom | Cause |
|---|---|
| Spotify shows "INVALID_CLIENT: Invalid redirect URI" | The URI in the dashboard is not exactly `http://127.0.0.1:8765/callback` (typo, `localhost`, `https`, trailing slash, or a port when Lineupify uses a random one, or no port when `SPOTIFY_REDIRECT_PORT` is set). |
| `SPOTIFY_CLIENT_ID_INVALID` | Wrong or truncated Client ID. It is 32 hex characters. |
| `BAD_CLIENT_ID` | Same as above, caught before login. |
| `SPOTIFY_FORBIDDEN` (403) after a successful login | You signed in with an account that is neither the app owner nor listed under User Management, or the owner does not have Premium. |
| Login page opens for the wrong account | Log out at https://www.spotify.com/logout, then call `connect` with `force: true`. |

## Every 6 months

Spotify refresh tokens expire 6 months after the original login. `status` starts warning 30 days before. When it happens, call `connect` with `force: true` (or run `lineupify-mcp auth --force`) and sign in again. Nothing else changes; drafts and playlists are unaffected.
