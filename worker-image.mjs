// Which images a worker may use, and getting an approved one onto the host.
//
// An allowlist entry is an exact image ref or a glob: `*` stands for any run of
// characters and `?` for one, neither crossing a `/`. So
// `nexus.pdtec.lan:5500/linux-*` approves every tag of every top-level `linux-*`
// repository on that registry, but not a nested path or another registry.
//
// Only an image the operator named — profile.image or an allowlist match — is
// pulled when the host lacks it. With no allowlist every requested image is
// accepted, as before, but only from the local store: otherwise any image a
// project asked for would be fetched and run with the workspace mounted.

const regExpSpecials = /[.+^${}()|[\]\\]/g;

function globToRegExp(pattern) {
  const source = pattern
    .replace(regExpSpecials, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`);
}

export function imageAllowed(image, patterns) {
  return patterns.some((pattern) => pattern === image || globToRegExp(pattern).test(image));
}

async function imagePresent(docker, image) {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch (error) {
    // Only a 404 means the image really is absent. Every other failure is the
    // daemon being unreachable — most often EACCES on /var/run/docker.sock when
    // the container is not in the socket's group. Reporting those as a missing
    // image sends the caller off pulling an image that is already there.
    if (error?.statusCode === 404) return false;
    throw Error(`cannot reach the Docker daemon to inspect ${image}: ${error?.message || error}`);
  }
}

async function pullImage(docker, image) {
  const events = await docker
    .pull(image)
    .then(
      (stream) =>
        new Promise((resolve, reject) =>
          docker.modem.followProgress(stream, (error, output) => (error ? reject(error) : resolve(output)))
        )
    )
    .catch((error) => {
      throw Error(`cannot pull ${image}: ${error?.message || error}`);
    });
  // A registry failure part-way through arrives as an event, not as an error.
  const failure = events.find((event) => event?.error);
  if (failure) throw Error(`cannot pull ${image}: ${failure.error}`);
}

export async function ensureLocalImage(docker, image, { pullIfMissing }) {
  if (await imagePresent(docker, image)) return { pulled: false };
  if (!pullIfMissing) throw Error(`approved local image is not available: ${image}`);

  console.log(`pulling ${image}`);
  await pullImage(docker, image);
  if (!(await imagePresent(docker, image))) {
    throw Error(`pulled ${image}, but the daemon still does not have it`);
  }
  console.log(`pulled ${image}`);
  return { pulled: true };
}
