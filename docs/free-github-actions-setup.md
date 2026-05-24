# Free GitHub Actions Setup

Absolute rules:

- The Instagram automation must run when the local computer is off.
- The required path must stay free. Do not require n8n Cloud API access, paid schedulers, or paid video generation.

## Required Free Runner

Use the workflow in:

```text
.github/workflows/instagram-carousel.yml
```

It runs on GitHub-hosted Ubuntu at:

- 09:35 KST
- 13:35 KST
- 17:35 KST

The scheduled run checks Instagram first. If the slot already has a Reel and a
feed post, it exits without publishing. If either format is missing, it
generates a post, runs legal review, uploads to Cloudinary, publishes the
missing format, and verifies the slot again.

## GitHub Secrets

Add these repository secrets:

```text
PEXELS_API_KEY
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
IG_USER_ID
META_ACCESS_TOKEN
META_GRAPH_VERSION
```

Optional free extras:

```text
PIXABAY_API_KEY
UNSPLASH_ACCESS_KEY
CLOUDINARY_UPLOAD_PRESET
REEL_SOURCE
PUBLISH_FORMAT_GAP_MS
FALLBACK_FORMAT_GAP_MS
```

Do not add an n8n API key. n8n Cloud/API access is not part of the required free
setup.

## Local Verification

Before pushing, run:

```bash
npm run preflight:free-cloud
npm run run:instagram-slot -- --slot 2026-05-24T17
```

The second command should exit without publishing if the slot is already
complete.
