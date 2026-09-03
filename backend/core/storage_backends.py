"""Cloudflare R2 (S3-compatible) storage backend for media files. Only
used when R2 credentials are configured (settings.USE_R2_STORAGE) -- see
Wave 2. Falls back to local FileSystemStorage in local dev otherwise.
"""

from django.conf import settings

try:
    from storages.backends.s3boto3 import S3Boto3Storage

    class R2MediaStorage(S3Boto3Storage):
        bucket_name = settings.R2_BUCKET_NAME
        file_overwrite = False
        default_acl = None
        querystring_auth = False

        def url(self, name, parameters=None, expire=None, http_method=None):
            if settings.R2_PUBLIC_BASE_URL:
                return f"{settings.R2_PUBLIC_BASE_URL.rstrip('/')}/{name}"
            return super().url(name, parameters=parameters, expire=expire, http_method=http_method)

except ImportError:  # django-storages not installed in this environment
    R2MediaStorage = None
