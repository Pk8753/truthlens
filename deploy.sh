#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud CLI is not installed or not on PATH." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Error: set PROJECT_ID or select a project with 'gcloud config set project PROJECT_ID'." >&2
  exit 1
fi

REGION="${REGION:-us-central1}"
BUCKET="${BUCKET:-${PROJECT_ID}-truthlens-videos}"
SERVICE="${SERVICE:-truthlens}"

echo "Deploying $SERVICE to project $PROJECT_ID in $REGION"
echo "Using bucket: gs://$BUCKET"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  --project="$PROJECT_ID"

DATABASES="$(gcloud firestore databases list --project="$PROJECT_ID" --format='value(name)')"
if [[ "$DATABASES" == *"/databases/(default)"* ]]; then
  echo "Firestore default database already exists; skipping creation."
else
  echo "Creating Firestore default database in $REGION..."
  gcloud firestore databases create \
    --database="(default)" \
    --location="$REGION" \
    --type=firestore-native \
    --project="$PROJECT_ID"
fi

if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Bucket gs://$BUCKET already exists; skipping creation."
else
  echo "Creating bucket gs://$BUCKET in $REGION..."
  gcloud storage buckets create "gs://$BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --project="$PROJECT_ID"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for ROLE in datastore.user storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SERVICE_ACCOUNT" \
    --role="roles/$ROLE" \
    --quiet
done

gcloud run deploy "$SERVICE" \
  --source "$SCRIPT_DIR" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --allow-unauthenticated \
  --max-instances=2 \
  --memory=1Gi \
  --no-cpu-throttling \
  --timeout=300 \
  --set-env-vars="BUCKET=$BUCKET"

SERVICE_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
echo
echo "Deployment complete: $SERVICE_URL"
