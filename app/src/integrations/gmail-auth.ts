import { isTauri } from '@/lib/platform';
import type { GmailTokens, GmailAuthState } from './types';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const REDIRECT_PORT = 19847;
const REDIRECT_URI = `http://localhost:${String(REDIRECT_PORT)}/oauth/callback`;

const STORAGE_KEY_TOKENS = 'nightjar_gmail_tokens';
const STORAGE_KEY_EMAIL = 'nightjar_gmail_email';
const STORAGE_KEY_SCAN_AT = 'nightjar_gmail_last_scan';

let cachedClientId: string | null = null;

export function setGmailClientId(clientId: string): void {
  cachedClientId = clientId;
}

function getClientId(): string {
  if (cachedClientId) return cachedClientId;
  const stored = localStorage.getItem('nightjar_gmail_client_id');
  if (stored) return stored;
  throw new Error('Gmail client ID not configured. Set it in Settings > Gmail.');
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function storeTokens(tokens: GmailTokens): Promise<void> {
  if (isTauri()) {
    try {
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('gmail-credentials.json');
      await store.set(STORAGE_KEY_TOKENS, tokens);
      await store.save();
      return;
    } catch {
      // Fall through to localStorage
    }
  }
  localStorage.setItem(STORAGE_KEY_TOKENS, JSON.stringify(tokens));
}

async function loadTokens(): Promise<GmailTokens | null> {
  if (isTauri()) {
    try {
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('gmail-credentials.json');
      const tokens = await store.get<GmailTokens>(STORAGE_KEY_TOKENS);
      if (tokens) return tokens;
    } catch {
      // Fall through to localStorage
    }
  }
  const raw = localStorage.getItem(STORAGE_KEY_TOKENS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GmailTokens;
  } catch {
    return null;
  }
}

async function clearTokens(): Promise<void> {
  if (isTauri()) {
    try {
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('gmail-credentials.json');
      await store.delete(STORAGE_KEY_TOKENS);
      await store.save();
    } catch {
      // Fall through
    }
  }
  localStorage.removeItem(STORAGE_KEY_TOKENS);
  localStorage.removeItem(STORAGE_KEY_EMAIL);
  localStorage.removeItem(STORAGE_KEY_SCAN_AT);
}

export async function getAuthState(): Promise<GmailAuthState> {
  const tokens = await loadTokens();
  if (!tokens) {
    return { connected: false, email: null, lastScanAt: null, error: null };
  }
  return {
    connected: true,
    email: localStorage.getItem(STORAGE_KEY_EMAIL),
    lastScanAt: localStorage.getItem(STORAGE_KEY_SCAN_AT),
    error: null,
  };
}

export function setLastScanAt(iso: string): void {
  localStorage.setItem(STORAGE_KEY_SCAN_AT, iso);
}

export async function startOAuthFlow(): Promise<void> {
  if (!isTauri()) {
    throw new Error('Gmail sync requires the desktop app (Tauri).');
  }

  const clientId = getClientId();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  sessionStorage.setItem('gmail_code_verifier', codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  const { open } = await import('@tauri-apps/plugin-shell');
  await open(authUrl);
}

export async function handleOAuthCallback(code: string): Promise<void> {
  const clientId = getClientId();
  const codeVerifier = sessionStorage.getItem('gmail_code_verifier');
  if (!codeVerifier) {
    throw new Error('OAuth flow state lost. Please try connecting again.');
  }
  sessionStorage.removeItem('gmail_code_verifier');

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!data.refresh_token) {
    throw new Error('No refresh token received. Please revoke access in Google account settings and try again.');
  }

  const tokens: GmailTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await storeTokens(tokens);

  try {
    const userResp = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (userResp.ok) {
      const user = await userResp.json() as { email?: string };
      if (user.email) {
        localStorage.setItem(STORAGE_KEY_EMAIL, user.email);
      }
    }
  } catch {
    // Email display is best-effort
  }
}

export async function getAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error('Gmail not connected.');
  }

  if (Date.now() < tokens.expiresAt - 60_000) {
    return tokens.accessToken;
  }

  return refreshAccessToken(tokens);
}

async function refreshAccessToken(tokens: GmailTokens): Promise<string> {
  const clientId = getClientId();

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refreshToken,
      client_id: clientId,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    await clearTokens();
    throw new Error('Gmail session expired. Please reconnect.');
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
  };

  const updated: GmailTokens = {
    ...tokens,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await storeTokens(updated);
  return updated.accessToken;
}

export async function disconnectGmail(): Promise<void> {
  const tokens = await loadTokens();
  if (tokens) {
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${tokens.refreshToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      // Revocation is best-effort
    }
  }
  await clearTokens();
}

export async function isGmailConnected(): Promise<boolean> {
  const tokens = await loadTokens();
  return tokens !== null;
}
