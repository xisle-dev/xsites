# Cloud Run deployment of the dynamic (read-write) editor -- see github
# issue #6 (Phase 5 of the Cloud Run + R2 migration, issue #1). Only the
# static assets the *editor* itself serves are copied in (index.html,
# app.js, style.css, logo/favicon, data/airspace.geojson, and the vector
# label tiles the embedded pmtiles server needs) -- not sites/ (site data
# and media live in R2 as of Phase 4, issue #5), not static/ (the
# read-only viewer, served from R2/CDN in production, never from here),
# not tools/ or .git.
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY server/ ./server/
RUN cd server && CGO_ENABLED=0 GOOS=linux go build -o /server .

# gcr.io/distroless/static-debian12 rather than alpine: ships CA certs
# (needed for the HTTPS calls to R2's API) and tzdata, but no shell or
# package manager -- smaller attack surface, and sidesteps the
# well-documented musl/cgo DNS resolution gotcha Alpine has with Go
# binaries (moot here since CGO_ENABLED=0, but no reason to risk it).
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /server /server
COPY index.html app.js style.css logo.svg favicon.svg ./
COPY data/ ./data/
COPY tiles/ ./tiles/
USER nonroot:nonroot
ENTRYPOINT ["/server", "-host=0.0.0.0", "-root=/app", "-store=r2"]
