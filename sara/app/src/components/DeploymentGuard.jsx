import { readRuntime } from '../runtime';

export default function DeploymentGuard() {
  const runtime = readRuntime();
  const issue = runtime.deploymentIssue;
  if (!issue) return null;

  const canOpenCanonical = issue.code === 'wrong-host' && runtime.canonicalUrl;

  return (
    <div className="deploy-guard">
      <div className="deploy-guard__card">
        <div className="deploy-guard__eyebrow">SARA Mobile</div>
        <h1 className="deploy-guard__title">{issue.title}</h1>
        <p className="deploy-guard__detail">{issue.detail}</p>

        <div className="deploy-guard__facts">
          <div><strong>Current host:</strong> {runtime.host || 'unknown'}</div>
          <div><strong>Brain URL:</strong> {runtime.apiBase || 'not set'}</div>
          {runtime.buildLabel && <div><strong>Build:</strong> {runtime.buildLabel}</div>}
        </div>

        {canOpenCanonical && (
          <a className="deploy-guard__cta" href={runtime.canonicalUrl}>
            Open the correct SARA Mobile site
          </a>
        )}

        <p className="deploy-guard__hint">
          Fix the Netlify custom-domain mapping for the mobile site, then remove and reinstall the iPhone home-screen app.
        </p>
      </div>
    </div>
  );
}
