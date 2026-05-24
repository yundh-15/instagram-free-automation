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

1. GitHub Actions: cloud runner at 09:35, 13:35, and 17:35 KST. It checks the slot, then publishes only if the Reel or feed post is missing.

Use GitHub Actions as the primary free scheduler. Do not make n8n API access a
required dependency for the final setup.

Every generated post must pass `npm run legal:review` before upload or
publication. The review blocks unverified local images, unknown image sources,
missing stock-license metadata, missing Reel source traceability, and public
wording that makes the account look like it is recruiting 체험단.

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
Actions path publishes the Reel first and the feed carousel last. Story
publishing is not part of the scheduled path to reduce Meta Graph API calls.

Feed and Reel captions are generated separately. Legal review blocks publication
if the two format captions are identical.

The active content pillars are massage, skincare, and posture/body-shape care.
Generated feed images are `1080x1350` (`4:5`) while important title text stays
inside the centered square crop used by the Instagram profile grid.

## Required Accounts And Keys

Pexels:

- Create a free API key at `https://www.pexels.com/api/`.
- Add it as `PEXELS_API_KEY`.
- Pexels says the API is free and default keys include rate limits, so avoid high-frequency runs.
- The same key is used for free stock photos and portrait stock videos for Reels.

Optional extra photo APIs:

- Pixabay: create an API key and add it as `PIXABAY_API_KEY`.
- Unsplash: create an API application and add the access key as `UNSPLASH_ACCESS_KEY`.
- Unsplash API usage requires attribution; the generator adds an Unsplash credit line when it uses an Unsplash image, and legal review blocks publication if that credit is missing.
- Photo search tries Korean/East Asian/person-focused queries first. If those results are too sparse, it falls back to the broader wellness queries so posting does not stall.

Cloudinary:

- Create a free account.
- Create an unsigned upload preset.
- Add `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
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
PEXELS_API_KEY
PIXABAY_API_KEY
UNSPLASH_ACCESS_KEY
REEL_AUDIO_PATH
REEL_AUDIO_URL
REEL_AUDIO_CLOUDINARY_PUBLIC_ID
REEL_AUDIO_VOLUME
REEL_AUDIO_TITLE
REEL_AUDIO_CREATOR
REEL_AUDIO_SOURCE_URL
REEL_AUDIO_LICENSE
REEL_AUDIO_CREDIT
CLOUDINARY_CLOUD_NAME
CLOUDINARY_UPLOAD_PRESET
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
IG_USER_ID
META_ACCESS_TOKEN
META_GRAPH_VERSION
```

The GitHub Actions schedule is enabled as a cloud fallback while n8n is the
primary scheduler. The scheduled job runs `npm run run:instagram-slot --
--fallback-publish`, so it first checks Instagram media for the current slot.
If n8n already posted both the Reel and feed carousel, it exits without
publishing. If either format is missing, it generates a fresh post, runs legal
review, uploads to Cloudinary, publishes only the missing format(s), and verifies
the slot again.

## Free Cloud Setup

The free PC-off path is the GitHub Actions workflow in:

```text
.github/workflows/instagram-carousel.yml
```

It runs at 09:35, 13:35, and 17:35 KST. It runs on GitHub-hosted Linux, so it
does not depend on the local Windows PC.

Local/GitHub flows can persist photo, video, and topic history in
`data/used-photos.json`, `data/used-videos.json`, and `data/used-topics.json`.
The scheduled workflow reduces repetition by checking recent Instagram media,
rotating stock API pages, using stock media source metadata, and blocking
duplicate scheduled slots before public posting.
