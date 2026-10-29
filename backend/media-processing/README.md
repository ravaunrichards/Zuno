# Media processing service

`src/file-validation.js` validates upload metadata and resource limits. It is not file-signature validation, malware scanning, transcoding or storage upload. Production upload paths must inspect actual file bytes, scan content and process media in an isolated worker.
