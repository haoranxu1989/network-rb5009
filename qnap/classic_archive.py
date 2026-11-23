"""Convert one tagged Buildx Docker export to the traditional docker save layout."""

import argparse
import gzip
import hashlib
import io
import json
import tarfile
import tempfile
from pathlib import Path


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def add_bytes(archive, name, data):
    member = tarfile.TarInfo(name)
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data))


def add_layer(archive, name, blob, expected):
    # Docker's classic layer.tar contains the original uncompressed tar bytes.
    with tempfile.TemporaryFile() as layer:
        digest = hashlib.sha256()
        stream = blob
        if blob.peek(2)[:2] == b"\x1f\x8b":
            stream = gzip.GzipFile(fileobj=blob, mode="rb")
        with stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                layer.write(chunk)
        if "sha256:" + digest.hexdigest() != expected:
            raise ValueError(f"Layer does not match {expected} (expected gzip or plain tar)")
        member = tarfile.TarInfo(name)
        member.size = layer.tell()
        layer.seek(0)
        archive.addfile(member, layer)


def convert(source, archive):
    with source.extractfile("manifest.json") as file:
        image, = json.load(file)
    with source.extractfile(image["Config"]) as file:
        config_bytes = file.read()
    config_id = hashlib.sha256(config_bytes).hexdigest()
    if Path(image["Config"]).stem != config_id:
        raise ValueError("Image configuration does not match its digest")
    config = json.loads(config_bytes)
    config_name = config_id + ".json"
    layers = image["Layers"]
    diff_ids = config["rootfs"]["diff_ids"]
    if not image["RepoTags"] or not layers or len(layers) != len(diff_ids):
        raise ValueError("Expected a tagged image with a complete layer list")

    add_bytes(archive, config_name, config_bytes)
    layer_paths = []
    chain = parent = ""
    for index, (blob_path, diff_id) in enumerate(zip(layers, diff_ids)):
        # Legacy IDs identify a layer together with its ancestry and image metadata.
        if chain:
            chain = "sha256:" + hashlib.sha256(f"{chain} {diff_id}".encode()).hexdigest()
        else:
            chain = diff_id
        metadata = {"created": "1970-01-01T00:00:00Z", "container_config": {}}
        if index == len(layers) - 1:
            fields = ("architecture", "os", "config", "created", "author", "variant")
            metadata.update({key: config[key] for key in fields if key in config})
        identity = dict(metadata, layer_id=chain)
        if parent:
            identity["parent"] = "sha256:" + parent
            metadata["parent"] = parent
        layer_id = hashlib.sha256(json_bytes(identity)).hexdigest()
        metadata["id"] = layer_id
        directory = tarfile.TarInfo(layer_id)
        directory.type, directory.mode = tarfile.DIRTYPE, 0o755
        archive.addfile(directory)
        add_bytes(archive, layer_id + "/VERSION", b"1.0")
        add_bytes(archive, layer_id + "/json", json_bytes(metadata))
        path = layer_id + "/layer.tar"
        with source.extractfile(blob_path) as blob:
            add_layer(archive, path, blob, diff_id)
        layer_paths.append(path)
        parent = layer_id

    repositories = {}
    for reference in image["RepoTags"]:
        repository, tag = reference.rsplit(":", 1)
        repositories.setdefault(repository, {})[tag] = parent
    manifest = [{"Config": config_name, "RepoTags": image["RepoTags"], "Layers": layer_paths}]
    add_bytes(archive, "manifest.json", json_bytes(manifest))
    add_bytes(archive, "repositories", json_bytes(repositories))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(dir=args.destination.parent) as staging:
        output = Path(staging) / "image.tar"
        with tarfile.open(args.source) as source:
            with tarfile.open(output, "w", format=tarfile.USTAR_FORMAT) as archive:
                convert(source, archive)
        output.replace(args.destination)
