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

It also runs recovery checks at 09:55/10:15, 13:55/14:15, and 17:55/18:15 KST.
The slot runner is idempotent, so recovery checks exit without publishing when
the Reel, feed post, and five Stories are already present.

The scheduled run checks Instagram first. If the slot already has a Reel, a
feed post, and five Stories, it exits without publishing. If any required
format is missing, it generates a post, runs legal review, uploads to
Cloudinary, publishes the missing format(s), and verifies the slot again.
Stories use the same photo order as the feed carousel.

Manual `workflow_dispatch` runs default to `dry_run=true`, which runs preflight
without publishing. Set `dry_run=false` only when intentionally publishing a
manual one-off post.

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
REQUIRED_STORY_COUNT
```

Do not add an n8n API key. n8n Cloud/API access is not part of the required free
setup.

## Local Verification

Before pushing, run:

```bash
npm run preflight:free-cloud
npm run check:instagram-slot -- --slot 2026-05-24T23
npm run run:instagram-slot -- --slot 2026-05-24T23
```

The last command should exit without publishing if the slot is already
complete.
