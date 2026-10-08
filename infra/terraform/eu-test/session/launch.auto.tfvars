# Support images for every TEST session: the same digests Production's service root (#131) pins.
# No secret, credential or tenant data.
redis_image    = "public.ecr.aws/docker/library/redis@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f"
postgres_image = "public.ecr.aws/docker/library/postgres@sha256:23af655ba1ddf74eaa002e3deaf5fce022ab8791672336a7c1fb0ef2d57efb7f" # 16.12
tunnel_image   = "public.ecr.aws/amazonlinux/amazonlinux@sha256:12052e9b5d3fd85769abbdd863dd038e1890c9ace31d5fdbe1afa78eda97d061" # 2023
