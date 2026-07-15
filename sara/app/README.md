# SARA Mobile

Lightweight mobile PWA for SARA, backed by the NEURO brain.

## Production deploy

This app must be deployed from `sara/app` as its own Netlify site.

Recommended environment variables:

```bash
VITE_API_URL=https://pi5.tailecb90f.ts.net
VITE_ALLOWED_HOSTS=your-mobile-domain.example.com,your-site.netlify.app
VITE_CANONICAL_URL=https://your-mobile-domain.example.com
VITE_BUILD_LABEL=prod-mobile
```

## Why the host guard exists

If the mobile custom domain is accidentally pointed at the wrong frontend, the iPhone PWA can look "offline" even when the NEURO brain is healthy. The runtime host guard makes that failure explicit so the problem is fixed at the Netlify/domain layer instead of being misdiagnosed as Tailscale or backend downtime.
