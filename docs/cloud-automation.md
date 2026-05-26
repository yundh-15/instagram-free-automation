# Instagram Carousel Automation

## Goal

Absolute operating rule: Instagram automation must run even when the local
computer is off. Any scheduler, recovery job, or fallback that only works while
the Windows PC is powered on is not a valid final solution; it can only be a
temporary diagnostic aid.

Absolute cost rule: every required part of the automation must fit a free
path. Paid services, paid API access, paid scheduler features, paid video
generation, or any setup that requires upgrading a plan are not valid final
dependencies. They can only be mentioned as optional alternatives, never as the
main solution.

This setup is designed so the pipeline can run even when your computer is off.
That means the scheduled job must run in GitHub Actions, not in local Windows
Task Scheduler or local n8n.

Supported free cloud path:

1. GitHub Actions: publishing slots begin at 09:00, 13:00, and 19:00 KST. Off-the-hour checks throughout each slot's two-hour publishing window publish only if the Reel, feed post, or Stories are missing.

Use GitHub Actions as the primary free scheduler. Do not make n8n API access a
required dependency for the final setup.
Before enabling this schedule, deactivate any previously deployed n8n workflow
for the same Instagram account; two active schedulers can publish duplicate
sets before either one can observe the other's posts.

Every generated post must pass `npm run legal:review` before upload or
publication. The review covers text rendered into every card as well as
captions, and blocks missing visual-copy metadata, unverified local images,
unknown image sources, missing stock-license metadata, missing Reel source
traceability, and public wording that makes the account look like it is
recruiting 체험단.

Reels use free Pexels stock video when a suitable portrait clip is available.
The video is uploaded to Cloudinary and then published through Instagram Graph.
If Pexels does not return a usable clip, the local publisher falls back to the
existing image slideshow unless `REEL_SOURCE=pexels-required` is set.

Licensed background music can be baked into the Reel MP4 before upload by
setting `REEL_AUDIO_PATH` or `REEL_AUDIO_URL`. Do not use a personal Google or
Instagram login for this. Download a track whose license allows Instagram use,
store the license metadata, and set `REEL_AUDIO_LICENSE`; otherwise the upload
script blocks the run. A quiet spa-style level is `REEL_AUDIO_VOLUME=0.18`.
For the free GitHub Actions setup, omit custom Reel music unless a properly
licensed file or HTTPS URL is available at no cost.

Publishing keeps a five-minute gap between public formats. The scheduled GitHub
Actions path publishes the Reel, then the feed carousel, then Stories. This
ensures topic-bearing formats pass duplicate checks before any Story is public. Story
images are published in the same slide order as the feed carousel: `01.png`,
`02.png`, `03.png`, `04.png`, then `05.png`.

Feed and Reel captions are generated separately with longer explanatory copy
and searchable title keywords. Legal review blocks publication if the two
format captions are identical.

The active content pillars are massage, skincare, and posture/body-shape care.
Generated feed images are `1080x1350` (`4:5`) while important title text stays
inside the centered square crop used by the Instagram profile grid. Cover
titles automatically add searchable keywords such as `마사지샵`, `피부관리샵`,
`에스테틱`, `체형교정`, or `자세교정` when they fit the content pillar.

## Required Accounts And Keys

Pexels (optional unless `REEL_SOURCE=pexels-required`):

- Create a free API key at `https://www.pexels.com/api/`.
- Add it as `PEXELS_API_KEY` to use stock media instead of generated/slideshow fallbacks.
- Pexels says the API is free and default keys include rate limits, so avoid high-frequency runs.
- The same key is used for free stock photos and portrait stock videos for Reels.

Optional extra photo APIs:

- Pixabay: create an API key and add it as `PIXABAY_API_KEY`.
- Unsplash: create an API application and add the access key as `UNSPLASH_ACCESS_KEY`.
- Unsplash API usage requires attribution; the generator adds an Unsplash credit line when it uses an Unsplash image, and legal review blocks publication if that credit is missing.
- Photo search tries Korean/East Asian/person-focused queries first. If those results are too sparse, it falls back to the broader wellness queries so posting does not stall.

Cloudinary:

- Create a free account.
- Optionally create an unsigned upload preset for slide image uploads.
- Add `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`; Reel/video creation needs signed API requests.
- Add `CLOUDINARY_UPLOAD_PRESET` only if using unsigned image uploads.
- This is needed because Instagram Graph API needs publicly reachable image URLs, not local files.

Meta / Instagram:

- Instagram account must be Professional.
- It must be connected to Meta/Facebook assets required by the selected Instagram API flow.
- Add `IG_USER_ID` and `META_ACCESS_TOKEN`.
- The token needs content publishing permission for the Instagram account.

## Local Test

```bash
npm run generate:sample
```

The output appears under `output/...` with:

- `01.png` to `05.png`
- `caption.txt`
- `post.json`

If you have any supported stock-photo API configured, the cards use free
stock-photo backgrounds. Without `PEXELS_API_KEY`, `PIXABAY_API_KEY`, or
`UNSPLASH_ACCESS_KEY`, the generator falls back to a generated graphic
background.

## Full Publish Pipeline

```bash
npm run generate -- --category massage --topic "어깨가 무거울 때 체크할 마사지 포인트"
npm run legal:review -- --post output/.../post.json
npm run upload:cloudinary -- --post output/.../post.json
npm run legal:review -- --payload output/.../public-image-urls.json
npm run publish:bundle -- --payload output/.../public-image-urls.json
```

OpenAI Sora video generation is not enabled in this project because it is paid
per generated second. Keep Reel generation on Pexels stock video unless a paid
video budget is approved.

## GitHub Actions Setup

The workflow file is already in:

```text
.github/workflows/instagram-carousel.yml
```

Add these repository secrets in GitHub:

```text
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
IG_USER_ID
META_ACCESS_TOKEN
```

Add optional settings only when used:

```text
PEXELS_API_KEY
PIXABAY_API_KEY
UNSPLASH_ACCESS_KEY
CLOUDINARY_UPLOAD_PRESET
META_GRAPH_VERSION
REEL_SOURCE
PUBLISH_FORMAT_GAP_MS
FALLBACK_FORMAT_GAP_MS
REQUIRED_STORY_COUNT
INSTAGRAM_DUPLICATE_TOPIC_WINDOW_MS
REEL_AUDIO_PATH
REEL_AUDIO_URL
REEL_AUDIO_VOLUME
REEL_AUDIO_TITLE
REEL_AUDIO_CREATOR
REEL_AUDIO_SOURCE_URL
REEL_AUDIO_LICENSE
REEL_AUDIO_CREDIT
```

The GitHub Actions schedule is the primary free scheduler. GitHub documents
that scheduled workflows can be delayed or dropped during heavy load,
especially at the start of an hour. The workflow therefore avoids `:00` and
checks each KST 09:00/13:00/19:00 slot at `+07`, `+27`, `+47`, `+67`, `+87`,
and `+107` minutes during its two-hour publishing window. Each scheduled job
runs `npm run run:instagram-slot -- --fallback-publish --settle-minutes 0`, so it first checks
Instagram media for the current slot. If the slot already
has the Reel, feed carousel, and required Stories, it exits without publishing.
If any required format is missing, it generates a fresh post, runs legal review,
uploads to Cloudinary, publishes only the missing format(s), and verifies the
slot again. When only some Stories were published before a failure, recovery
publishes only the number still needed for the configured Story target instead
of posting a second full set. Scheduled content selection is stable per slot,
so a recovery that can see only partial Stories regenerates the same topic.
When the Reel already exists, Story/feed recovery skips unnecessary Reel video
creation and cannot be blocked by an unrelated video-source failure.
Each slot has six idempotent checks within the two-hour publishing window.
Publishing closes two hours after its scheduled start so an excessively
delayed GitHub run cannot post repeated off-slot content. If late publishing is
explicitly enabled for manual recovery, results remain attributed to that slot
until the next scheduled slot begins, preventing repeated recovery runs from
publishing them again.
Before publishing a new slot, the runner obtains recent Instagram captions and
selects a different topic from the same content pillar. A second guard blocks
any topic seen in the last seven days by default. Reel and feed publishers also
block a duplicate of their own format immediately before publication, and
Stories require an already published Reel or feed anchor for that topic. If
another publisher adds media after the initial slot check while fallback
content is being prepared, the run stops without posting and leaves recovery
to the next check.

## Free Cloud Setup

The free PC-off path is the GitHub Actions workflow in:

```text
.github/workflows/instagram-carousel.yml
```

It manages slots beginning at 09:00, 13:00, and 19:00 KST, checking each one
at `+07`, `+27`, `+47`, `+67`, `+87`, and `+107` minutes to avoid top-of-hour
schedule congestion and recover from delayed or dropped checks. It runs on
GitHub-hosted Linux, so it does not depend on the local Windows PC.

Local/GitHub flows can persist photo, video, and topic history in
`data/used-photos.json`, `data/used-videos.json`, and `data/used-topics.json`.
The scheduled workflow reduces repetition by checking recent Instagram media,
rotating stock API pages, using stock media source metadata, and blocking
duplicate scheduled slots before public posting.
