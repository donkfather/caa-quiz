# Chestionare Barca website

Static presentation website for the app.

Production URL used for SEO metadata:

```text
https://chestionarebarca.bhdit.ro/
```

## Local preview

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/website/`.

## Coolify

Deploy as a Dockerfile application with:

- Base directory: `/`
- Dockerfile: `website/Dockerfile`
- Port exposes: `80`

## SEO files

- `robots.txt`
- `sitemap.xml`
- `site.webmanifest`
- `og-image.png`
