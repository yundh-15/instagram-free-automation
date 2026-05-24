# Pexels API Setup

Pexels API page:

```text
https://www.pexels.com/api/
```

What to do:

1. Log in to Pexels.
2. Go to the API page.
3. Click Get Started.
4. Create/copy your API key.
5. Put it in `.env` for local runs:

```bash
PEXELS_API_KEY=your_key_here
```

For GitHub Actions, add the same value as a repository secret named:

```text
PEXELS_API_KEY
```

The generator already uses this key. It searches for spa, massage, skincare,
posture, or wellness photos depending on the selected category, downloads one
free stock image, and uses it as the carousel background.

Pexels license notes:

- Pexels photos and videos are free to use.
- Attribution is not required, but Pexels asks that credit is given when possible.
- Do not imply that people or brands in photos endorse your account or service.
- Check current Pexels terms before scaling automated commercial posting.
