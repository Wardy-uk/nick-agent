import { API_BASE } from './api';

const RAW_ALLOWED_HOSTS = import.meta.env.VITE_ALLOWED_HOSTS || '';
const RAW_CANONICAL_URL = import.meta.env.VITE_CANONICAL_URL || '';
const BUILD_LABEL = import.meta.env.VITE_BUILD_LABEL || '';

function parseHosts(raw) {
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function readCanonical(raw) {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function readRuntime() {
  if (typeof window === 'undefined') {
    return {
      apiBase: API_BASE,
      allowedHosts: parseHosts(RAW_ALLOWED_HOSTS),
      canonicalUrl: readCanonical(RAW_CANONICAL_URL)?.toString() || '',
      buildLabel: BUILD_LABEL,
      host: '',
      origin: '',
      path: '',
      deploymentIssue: null,
    };
  }

  const host = window.location.host.toLowerCase();
  const origin = window.location.origin;
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const allowedHosts = parseHosts(RAW_ALLOWED_HOSTS);
  const canonical = readCanonical(RAW_CANONICAL_URL);

  let deploymentIssue = null;

  if (!API_BASE) {
    deploymentIssue = {
      code: 'missing-api-base',
      title: 'SARA Mobile is missing its backend target',
      detail: 'This build has no NEURO brain URL configured, so it can only show the shell.',
    };
  } else if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    deploymentIssue = {
      code: 'wrong-host',
      title: 'This is not the intended SARA Mobile host',
      detail: `The app is running on ${host}, but this build only trusts ${allowedHosts.join(', ')}.`,
    };
  }

  return {
    apiBase: API_BASE,
    allowedHosts,
    canonicalUrl: canonical?.toString() || '',
    buildLabel: BUILD_LABEL,
    host,
    origin,
    path,
    deploymentIssue,
  };
}
