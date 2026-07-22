FROM python:3.11-slim

WORKDIR /app

# System deps some ML wheels need. Versions are intentionally unpinned: this is a
# slim base that gets rebuilt regularly, and pinning apt versions here breaks on
# every base-image refresh with no real supply-chain gain (we pin Python deps).
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 8001

# Run unprivileged (python:slim has no non-root user by default).
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8001/healthz').status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
