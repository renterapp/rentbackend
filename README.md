# rentbackend

## Docker

Build and run locally with a `.env` file containing `DATABASE_URL`, a strong
`JWT_SECRET`, and the storage settings listed in `.env.example`:

```sh
docker build -t rentbackend .
docker run --rm --env-file .env -p 8080:8080 rentbackend
curl http://localhost:8080/
```

`/health` also checks database connectivity. The database must be reachable from
the container; `localhost` in `DATABASE_URL` refers to the container itself.
The image compiles TypeScript, generates the Prisma client, and runs as a non-root
user. Environment files and credentials are excluded from the image. This repo
currently has no committed npm lockfile, so dependency versions resolve at build
time.

## Google Cloud Run

With the Google Cloud CLI authenticated, a project selected, billing enabled,
and the Cloud Run and Cloud Build APIs enabled:

1. Create Secret Manager secrets named `rent-database-url` and `rent-jwt-secret`.
   Grant the Cloud Run runtime service account Secret Manager Secret Accessor on
   those secrets. `DATABASE_URL` must point to a reachable PostgreSQL database
   with the application's schema already provisioned; the container does not run
   database migrations. For Cloud SQL, configure its connection and networking
   separately.
2. Deploy from this directory (replace `YOUR_PROJECT_ID`):

   ```sh
   gcloud run deploy rentbackend \
     --project YOUR_PROJECT_ID \
     --source . \
     --region asia-south1 \
     --port 8080 \
     --set-secrets DATABASE_URL=rent-database-url:latest,JWT_SECRET=rent-jwt-secret:latest \
     --min 1 \
     --max 1 \
     --no-cpu-throttling \
     --no-allow-unauthenticated
   ```

3. Configure the `AWS_*` settings from `.env.example` for document storage,
   supplying access keys through Secret Manager. The app currently uses
   S3-compatible storage; hosting it on GCP does not switch it to Cloud Storage.

The example keeps Cloud Run access protected by IAM. If clients need to call the
API directly, explicitly enable unauthenticated invocation after reviewing the
app's route authentication. Always supply `JWT_SECRET`; the code has a development
fallback.

The existing rent scheduler runs inside each server process. Minimum instances
and continuously allocated CPU help it run when idle, and the maximum limits
normal scaling, but restarts and overlapping revisions can still interrupt or
duplicate jobs. These settings also incur idle-instance charges. For reliable
daily processing, move the scheduler to a Cloud Scheduler-triggered job before
relying on it for production billing.

References: [Cloud Run container contract](https://cloud.google.com/run/docs/container-contract)
and [deployment flags](https://cloud.google.com/sdk/gcloud/reference/run/deploy).
