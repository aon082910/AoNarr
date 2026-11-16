# AoNarr

AoNarr is one self-hosted app that does the job of Sonarr, Radarr, Lidarr, Readarr, Prowlarr, Bazarr and Whisparr, plus ROMs, comics, online videos and courses. You get ten libraries, one place for indexers and download clients, and one scheduler that searches, grabs and imports for all of them. It's built for Unraid.

What makes it worth running instead of a pile of separate containers:

- **One app, ten libraries.** Movies, TV, Anime, Music, Books, Comics, ROMs, Online Videos, Courses and Adult.
- **Quality control you can tune.** Reorder quality profiles and score releases with custom formats.
- **Household accounts.** Give family members read access to the libraries they should see, with a request queue you approve.
- **Health at a glance.** A dashboard that tells you what's stuck, unreachable or about to fill the disk.

## Install on Unraid

Search for **AoNarr** in Community Applications. If it isn't listed yet, go to Apps → Settings → Template Repositories, add `https://github.com/aon082910/AoNarr`, and pick the `aonarr` template.

Or run it with Docker:

```bash
docker run -d --name aonarr \
  -p 9876:9876 \
  -v /mnt/user/appdata/aonarr/config:/config \
  -v /mnt/user/media:/media \
  -v /mnt/user/downloads:/downloads \
  -e PUID=99 -e PGID=100 \
  allornothing/aonarr:combined
```

Then open `http://<unraid-ip>:9876` and create your admin account.

**Volumes**

| Path | What it's for |
|---|---|
| `/config` | Database and settings |
| `/media` | Your media library |
| `/downloads` | Must be the same folder your download client saves finished files to |

The `docker-compose.yml` in this repo runs the same thing as two containers (server and web) if you'd rather split them.

## First setup

1. In **Settings**, add a root folder for each library you'll use, plus any metadata API keys you want.
2. Add your Torznab/Newznab indexers.
3. Add qBittorrent or SABnzbd as a download client.
4. Use **Add Media**, and AoNarr takes it from there: search, grab, import.

## Optional settings

- `URL_BASE` serves AoNarr under a sub-path like `/aonarr` behind a reverse proxy.
- `AONARR_CORS_ALLOWED_ORIGINS` lets another site's page (a dashboard widget, say) call the API.
- `AONARR_BIND_ADDRESS` limits which network interface the API listens on.

## Help and development

Questions or bugs: [open an issue](https://github.com/aon082910/AoNarr/issues). The full change history is in `CHANGELOG.md`. To hack on it you'll need Node.js 20; run `npm install && npm run dev` in `server/` and `web/`.

See `LICENSE` for the license.
