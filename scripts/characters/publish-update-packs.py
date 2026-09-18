"""Official HF API publisher, invoked only with a fully validated exact-file plan.

Developer dependency: huggingface_hub. Never shipped as an app dependency.
No token arguments, repository-wide uploads, deletion, or visibility changes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.parse
import urllib.request

HOSTS = {"huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "us.gcp.cdn.hf.co", "cas-server.xethub.hf.co", "cas-server.xethub-eu.hf.co", "transfer.xethub.hf.co", "transfer.xethub-eu.hf.co"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def anonymous(repo, revision, path, limit, collect=False):
    url = f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{path}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for _ in range(6):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "https" or u.hostname not in HOSTS or u.port not in (None, 443) or u.username or u.password or u.fragment:
            raise RuntimeError("DISALLOWED_REDIRECT")
        try:
            response = opener.open(urllib.request.Request(url, headers={"Accept-Encoding": "identity"}), timeout=30)
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308):
                url = urllib.parse.urljoin(url, error.headers["Location"])
                error.close()
                continue
            raise RuntimeError(f"ANONYMOUS_HTTP_{error.code}") from None
        with response:
            digest, size, chunks = hashlib.sha256(), 0, []
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise RuntimeError("SIZE_MISMATCH")
                digest.update(chunk)
                if collect:
                    chunks.append(chunk)
            return size, digest.hexdigest(), b"".join(chunks)
    raise RuntimeError("REDIRECT_LIMIT")


def publish(plan, record_path, create_repo):
    from huggingface_hub import HfApi, CommitOperationAdd
    from huggingface_hub.errors import RepositoryNotFoundError
    api = HfApi()
    api.whoami()  # Uses existing local authentication; never prints credentials.
    repo = plan["repoId"]
    try:
        info = api.repo_info(repo, repo_type="dataset")
    except RepositoryNotFoundError:
        if not create_repo:
            raise RuntimeError("BLOCKED_DESTINATION") from None
        api.create_repo(repo, repo_type="dataset", private=False)
        info = api.repo_info(repo, repo_type="dataset")
    if info.private or info.gated:
        raise RuntimeError("REQUIRES_PUBLIC_UNGATED_REPOSITORY")
    record = json.loads(record_path.read_text()) if record_path.exists() else {"repoId": repo, "packs": {}}
    if record["repoId"] != repo:
        raise RuntimeError("RECORD_DESTINATION_CONFLICT")

    def save():
        temporary = record_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        os.chmod(temporary, 0o600)
        temporary.replace(record_path)

    paths = set(api.list_repo_files(repo, repo_type="dataset", revision=info.sha))
    operations = []
    for item in plan["packs"]:
        digest = hashlib.file_digest(open(item["file"], "rb"), "sha256").hexdigest()
        if digest != item["sha256"]:
            raise RuntimeError("LOCAL_BYTES_CHANGED")
        previous = record["packs"].get(item["path"])
        if previous and previous["sha256"] != digest:
            raise RuntimeError("IMMUTABLE_VERSION_CONFLICT")
        if item["path"] in paths:
            size, sha, _ = anonymous(repo, info.sha, item["path"], item["bytes"])
            if (size, sha) != (item["bytes"], digest):
                raise RuntimeError("IMMUTABLE_VERSION_CONFLICT")
        else:
            operations.append(CommitOperationAdd(path_in_repo=item["path"], path_or_fileobj=item["file"]))
    for doc in plan["documents"]:
        if hashlib.file_digest(open(doc["file"], "rb"), "sha256").hexdigest() != doc["sha256"]:
            raise RuntimeError("LOCAL_DOCUMENT_CHANGED")
        operations.append(CommitOperationAdd(path_in_repo=doc["path"], path_or_fileobj=doc["file"]))
    artifact_commit = api.create_commit(repo, repo_type="dataset", operations=operations, commit_message="Add validated character pack artifacts", parent_commit=info.sha).oid if operations else info.sha
    record["artifactCommit"] = artifact_commit
    save()
    for item in plan["packs"]:
        size, sha, _ = anonymous(repo, artifact_commit, item["path"], item["bytes"])
        if (size, sha) != (item["bytes"], item["sha256"]):
            raise RuntimeError("ARTIFACT_READBACK_FAILED")
        record["packs"][item["path"]] = {"sha256": sha, "bytes": size, "artifactCommit": artifact_commit, "anonymous": "PASS"}
        save()
    # Recheck remote feeds at a fresh HEAD. Concurrent writes use an expected parent.
    head = api.repo_info(repo, repo_type="dataset").sha
    current_paths = set(api.list_repo_files(repo, repo_type="dataset", revision=head))
    feeds, generated = [], {}
    for item in plan["packs"]:
        feed = item["feed"]
        feed["artifact"]["revision"] = artifact_commit
        if item["manifestPath"] in current_paths:
            _, _, raw = anonymous(repo, head, item["manifestPath"], 65536, True)
            previous = json.loads(raw)
            if previous["packId"] != feed["packId"]:
                raise RuntimeError("REMOTE_FEED_ID_CONFLICT")
            before = tuple(map(int, previous["version"].split(".")))
            after = tuple(map(int, feed["version"].split(".")))
            if before > after or before == after and (previous["artifact"]["sha256"] != item["sha256"] or previous["artifact"]["bytes"] != item["bytes"]):
                raise RuntimeError("REMOTE_FEED_VERSION_CONFLICT")
            if before == after:
                # Preserve the original immutable commit on a resumable equal-version publication.
                feed = previous
        raw = (json.dumps(feed, ensure_ascii=False, indent=2) + "\n").encode()
        generated[item["manifestPath"]] = raw
        feeds.append(CommitOperationAdd(path_in_repo=item["manifestPath"], path_or_fileobj=raw))
    feed_commit = api.create_commit(repo, repo_type="dataset", operations=feeds, commit_message="Publish verified character pack feeds", parent_commit=head).oid
    record["feedCommit"] = feed_commit
    save()
    for path, expected in generated.items():
        _, _, actual = anonymous(repo, feed_commit, path, 65536, True)
        if json.loads(actual) != json.loads(expected):
            raise RuntimeError("FEED_READBACK_FAILED")
        target = record_path.parent / "published-feeds" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(actual)
    record["feedAnonymousReadback"] = "PASS"
    save()
    return {"repoId": repo, "artifactCommit": artifact_commit, "feedCommit": feed_commit, "anonymousReadback": "PASS"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--record", required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--create-repo", action="store_true")
    args = parser.parse_args()
    if not args.publish:
        raise SystemExit("Dry-run: publication requires the validated Node helper and --publish")
    try:
        print(json.dumps(publish(json.loads(Path(args.plan).read_text()), Path(args.record), args.create_repo)))
    except Exception as error:
        # Third-party exceptions can contain signed URLs. Never echo their message or traceback.
        print(json.dumps({"status": "BLOCKED_PUBLICATION", "errorType": type(error).__name__}))
        raise SystemExit(1)
