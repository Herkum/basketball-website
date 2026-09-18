// Cognito Hosted UI login via Authorization Code + PKCE (no client secret needed).

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

function getIdToken() {
  return sessionStorage.getItem("id_token");
}

// Cognito id_tokens carry `email` as a standard claim - decoded client-side
// (never verified here, the API's JWT authorizer is what actually enforces
// the token) purely so the admin UI knows which Users row is "me", to hide
// nav sections the signed-in user lacks permission for.
function getCurrentEmail() {
  const token = getIdToken();
  if (!token) return null;
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(payload)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
    return (JSON.parse(json).email || "").toLowerCase() || null;
  } catch (e) {
    return null;
  }
}

function isLoggedIn() {
  const expiresAt = Number(sessionStorage.getItem("expires_at") || 0);
  return !!getIdToken() && Date.now() < expiresAt;
}

let sessionTimeoutId = null;

// The dashboard is a single page that's never reloaded during normal use, so
// isLoggedIn()'s Date.now() check alone would only catch an expired session
// the next time something happens to re-check it (a submit, a tab switch).
// This schedules an actual timer for the token's expiry so the session ends
// itself -- back to the login screen -- the moment it expires, with no user
// action required.
function scheduleSessionTimeout() {
  if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
  const expiresAt = Number(sessionStorage.getItem("expires_at") || 0);
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    logout();
    return;
  }
  sessionTimeoutId = setTimeout(logout, remaining);
}

async function startLogin() {
  const verifier = generateCodeVerifier();
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem("pkce_verifier", verifier);

  const params = new URLSearchParams({
    client_id: window.APP_CONFIG.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: window.APP_CONFIG.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${window.APP_CONFIG.cognitoDomain}/oauth2/authorize?${params}`;
}

async function exchangeCodeForTokens(code) {
  const verifier = sessionStorage.getItem("pkce_verifier");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: window.APP_CONFIG.clientId,
    code,
    redirect_uri: window.APP_CONFIG.redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(`${window.APP_CONFIG.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }

  const tokens = await response.json();
  sessionStorage.setItem("id_token", tokens.id_token);
  sessionStorage.setItem("expires_at", String(Date.now() + tokens.expires_in * 1000));
  sessionStorage.removeItem("pkce_verifier");
}

function logout() {
  if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
  sessionStorage.clear();
  const params = new URLSearchParams({
    client_id: window.APP_CONFIG.clientId,
    logout_uri: window.APP_CONFIG.logoutUri,
  });
  window.location.href = `${window.APP_CONFIG.cognitoDomain}/logout?${params}`;
}

async function apiFetch(path, options = {}) {
  const token = getIdToken();
  const response = await fetch(`${window.APP_CONFIG.apiBase}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    logout();
    throw new Error("Not authorized");
  }

  if (response.status === 403) {
    // Session is still valid - the signed-in user just lacks the
    // permission this action needs, so surface it instead of logging out.
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "You don't have permission to do that.");
  }

  if (response.status === 204) return null;
  return response.json();
}

async function uploadImageBlob(blob, contentType) {
  const { uploadUrl, key } = await apiFetch("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: contentType }),
  });

  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });

  if (!putResponse.ok) {
    throw new Error(`Image upload failed: ${putResponse.status}`);
  }

  return `${window.APP_CONFIG.siteOrigin}/${key}`;
}
