# Free GitHub Actions Setup

Absolute rules:

- The Instagram automation must run when the local computer is off.
- The required path must stay free. Do not require n8n Cloud API access, paid schedulers, or paid video generation.

## Required Free Runner

Use the workflow in:

```text
.github/workflows/instagram-carousel.yml
```

It starts on GitHub-hosted Ubuntu at:

- 09:00 KST
- 13:00 KST
- 19:00 KST

It also runs recovery checks at 09:20/09:40, 13:20/13:40, and 19:20/19:40 KST.
The slot runner is idempotent, so recovery checks exit without publishing when
the Reel, feed post, and five Stories are already present.
Scheduled publishing stops two hours after a slot begins. A GitHub run delayed
beyond that cutoff fails closed instead of publishing off-slot duplicates.

Keep this as the only active scheduler for the Instagram account. Deactivate
any previously imported n8n Cloud workflow before relying on this schedule;
running both schedulers can publish two sets in the same slot.

The scheduled run checks Instagram first. If the slot already has a Reel, a
feed post, and five Stories, it exits without publishing. If any required
format is missing, it generates a post, runs legal review, uploads to
Cloudinary, publishes the missing format(s), and verifies the slot again.
Stories use the same photo order as the feed carousel; after a partially
successful Story run, recovery publishes only the remaining required count.
Scheduled retries use a stable per-slot content key so a Story-only partial
failure does not switch to a different topic on the recovery run.
Results are observed through the beginning of the next slot, so an explicitly
approved late manual recovery cannot be repeated by a later recovery check.

Manual `workflow_dispatch` runs default to `dry_run=true`, which runs preflight
without publishing. Set `dry_run=false` only when intentionally publishing a
manual one-off post.

## GitHub Secrets

Add these repository secrets:

```text
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
IG_USER_ID
META_ACCESS_TOKEN
META_GRAPH_VERSION
```

Optional free extras:

```text
PEXELS_API_KEY
PIXABAY_API_KEY
UNSPLASH_ACCESS_KEY
CLOUDINARY_UPLOAD_PRESET
REEL_SOURCE
PUBLISH_FORMAT_GAP_MS
FALLBACK_FORMAT_GAP_MS
REQUIRED_STORY_COUNT
```

Set `PEXELS_API_KEY` when using stock photos/videos. It becomes required when
`REEL_SOURCE=pexels-required`; otherwise the pipeline can fall back to
generated card backgrounds and a slideshow Reel.

Do not add an n8n API key. n8n Cloud/API access is not part of the required free
setup.

## Local Verification

Before pushing, run:

```bash
npm run preflight:free-cloud
npm run check:instagram-slot -- --slot 2026-05-24T19
npm run run:instagram-slot -- --slot 2026-05-24T19
```

The last command should exit without publishing if the slot is already
complete.
