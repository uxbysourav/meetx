# Meet X

Meet X is a Zoom-style meeting starter app with a static frontend for GitHub Pages and a Render-hosted Node.js signaling API.

## Features

- Create and join meetings with a meeting code
- Room creator becomes admin
- Peer-to-peer voice and video with WebRTC
- Text chat with recent message history
- Raise hand status
- Admin kick controls
- Screen sharing permission flow for non-admin users
- Admin-only whiteboard drawing and clear
- Socket.IO signaling backend with health endpoint
- GitHub Pages deployment workflow
- Render blueprint

## Project Structure

```text
frontend/
  index.html
  styles.css
  app.js
  config.js
  logo.svg
backend/
  package.json
  server.js
.github/workflows/pages.yml
render.yaml
```

## Local Development

Install and start the backend:

```bash
cd backend
npm install
npm start
```

Open `frontend/index.html` in a browser, or serve the folder with any static server. The default API URL in `frontend/config.js` is:

```js
window.MEET_X_API_URL = "http://localhost:5000";
```

This repo also includes a small local static server:

```bash
node tools/static-server.js
```

Then open:

```text
http://127.0.0.1:5500
```

You can also override it without editing files:

```text
index.html?api=https://your-render-service.onrender.com
```

## Deploy Backend on Render

1. Push this repository to GitHub.
2. In Render, create a new Blueprint from the repository.
3. Render will use `render.yaml` and start the backend from `backend/server.js`.
4. Copy the Render service URL.
5. Update `frontend/config.js` to use that URL:

```js
window.MEET_X_API_URL = "https://your-render-service.onrender.com";
```

For tighter CORS, set `CLIENT_ORIGIN` in Render to your GitHub Pages URL instead of `*`.

### Render Environment Variables

Add these in Render > your service > Environment:

```text
CLIENT_ORIGIN=https://your-github-username.github.io
```

If your GitHub Pages site is a project page, use the full Pages origin only:

```text
CLIENT_ORIGIN=https://your-github-username.github.io
```

Render sets `PORT` automatically. Do not add `PORT` unless Render asks for it.

No database, JWT secret, API key, or email secret is required for this starter version because rooms are stored in memory.

## Deploy Frontend on GitHub Pages

1. Push to the `main` branch.
2. In GitHub, open Settings > Pages.
3. Set Source to GitHub Actions.
4. The workflow at `.github/workflows/pages.yml` uploads the `frontend` folder.

### GitHub Secrets

No GitHub secrets are required for the current workflow.

Before deploying, edit `frontend/config.js`:

```js
window.MEET_X_API_URL = "https://your-render-service.onrender.com";
```

Then commit and push to `main`. GitHub Actions will publish the frontend.

## Error Handling

The frontend shows clear messages for:

- Creating a room without a name
- Joining without a name
- Joining without a meeting code
- Joining with an invalid-looking code
- Joining with a meeting code that does not exist
- Backend/API connection failures

## Notes

WebRTC voice, video, and screen sharing require HTTPS in production. GitHub Pages and Render provide HTTPS URLs. Some restrictive networks may need a TURN server for reliable calls; this starter uses Google's public STUN server only.
