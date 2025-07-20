import { gzip } from 'pako';

const GITHUB_REPO = "liquidprjkt/liquid_kernel_desktop_x86";
const GITHUB_TOKEN = typeof process !== 'undefined' ? process.env.GITHUB_TOKEN : 
                     typeof Deno !== 'undefined' ? Deno.env.get('GITHUB_TOKEN') : 
                     import.meta.env?.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is not set');
}

function makeTarHeader(name, size) {
  const buf = new Uint8Array(512);
  const encoder = new TextEncoder();
  const write = (offset, str, length) => {
    const data = encoder.encode(str);
    buf.set(data.slice(0, length), offset);
  };

  write(0, name.padEnd(100, '\0'), 100);
  write(100, '000644\0', 8);
  write(108, '000000\0', 8);
  write(116, '000000\0', 8);
  write(124, size.toString(8).padStart(11, '0') + '\0', 12);
  write(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 12);
  write(156, '0', 1);
  write(257, 'ustar\0', 6);
  write(263, '00', 2);

  for (let i = 148; i < 156; i++) buf[i] = 32;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  write(148, sum.toString(8).padStart(6, '0') + '\0 ', 8);

  return buf;
}

function buildTar(files) {
  const chunks = [];

  for (const file of files) {
    const header = makeTarHeader(file.name, file.content.length);
    chunks.push(header);
    chunks.push(file.content);

    const pad = file.content.length % 512;
    if (pad !== 0) chunks.push(new Uint8Array(512 - pad));
  }

  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((a, b) => a + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function dummySig() {
  return crypto.getRandomValues(new Uint8Array(512));
}

function generatePackageList(packages) {
  return packages.map(pkg => pkg.asset.name).join('\n');
}

export async function GET(req) {
  const { pathname, searchParams } = new URL(req.url);
  const isFiles = pathname.endsWith(".files");
  const isSig = pathname.endsWith(".sig");
  const isPkg = searchParams.has('pkg');
  const isPkgList = pathname.endsWith(".pkgs");
  const base = pathname.replace(/^.*\/(liquid\.(db|files|pkgs))(\.sig)?$/, "$1");

  try {
    if (isPkg) {
      const pkgName = searchParams.get('pkg');
      const versionTag = pkgName.match(/(\d+\.\d+\.\d+_liquid-\d+)/)?.[1];
      if (!versionTag) throw new Error("Invalid package version format");
      
      const res = await fetch(
        `https://github.com/${GITHUB_REPO}/releases/download/${versionTag}/${pkgName}`,
        {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/octet-stream',
            'User-Agent': 'liquid-repo'
          }
        }
      );
      
      if (!res.ok) throw new Error(`Failed to download package: ${res.status} - ${await res.text()}`);
      
      return new Response(res.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'liquid-kernel-mirror',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!res.ok) throw new Error(`GitHub API error: ${res.status} - ${await res.text()}`);
    const releases = await res.json();
    const files = [];
    const encoder = new TextEncoder();

    // Get all valid packages
    const validPackages = [];
    for (const release of releases) {
      for (const asset of release.assets || []) {
        if (asset.name.endsWith('.pkg.tar.zst') && 
           asset.name.match(/^linux-upstream(?:-[a-z-]+)?-\d+\.\d+\.\d+_liquid-\d+-x86_64\.pkg\.tar\.zst$/)) {
          validPackages.push({
            asset,
            release,
            date: new Date(release.published_at)
          });
        }
      }
    }

    // Sort by date
    validPackages.sort((a, b) => b.date - a.date);
    const latestPackages = validPackages.slice(0, 3);

    if (isPkgList) {
      // Return plain text list of all package names
      const pkgList = validPackages.map(p => p.asset.name).join('\n');
      return new Response(pkgList, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // Process only the 3 latest packages for db/files
    for (const {asset, release} of latestPackages) {
      const releaseVersion = release.tag_name;
      const match = asset.name.match(/^(linux-upstream(?:-[a-z-]+)?)-(\d+\.\d+\.\d+_liquid-\d+)-(x86_64)\.pkg\.tar\.zst$/);
      if (!match) continue;

      const [, name, version, arch] = match;
      const filename = asset.name;
      const builddate = Math.floor(new Date(release.published_at).getTime() / 1000);
      const sha256 = (asset.label || '').match(/sha256:([a-f0-9]{64})/)?.[1] || '0'.repeat(64);
      const dirName = `${name}-${version}`;

      if (isFiles) {
        files.push({
          name: `${dirName}/files`,
          content: encoder.encode(`.${filename}\n/usr/lib/modules/${version.replace(/_/g, '.')}/vmlinuz`)
        });
      } else {
        const desc = [
          '%FILENAME%', filename,
          '%NAME%', name,
          '%BASE%', name,
          '%VERSION%', version,
          '%DESC%', 'Liquid Kernel for Arch Linux',
          '%CSIZE%', asset.size,
          '%ISIZE%', '0',
          '%MD5SUM%', '0'.repeat(32),
          '%SHA256SUM%', sha256,
          '%PGPSIG%', 'NONE',
          '%URL%', `https://github.com/${GITHUB_REPO}/releases/download/${release.tag_name}/${filename}`,
          '%LICENSE%', 'GPL2',
          '%ARCH%', arch,
          '%BUILDDATE%', builddate,
          '%PACKAGER%', 'Liquid Mirror <hi@zamkara.tech>',
          ''
        ].join('\n');

        files.push({
          name: `${dirName}/desc`,
          content: encoder.encode(desc)
        });
      }
    }

    if (isSig) {
      return new Response(dummySig(), {
        headers: {
          'Content-Type': 'application/pgp-signature',
          'Content-Disposition': `inline; filename="${base}.sig"`,
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    const tar = buildTar(files);
    const gz = gzip(tar);

    return new Response(gz, {
      headers: {
        'Content-Type': 'application/vnd.pacman.db',
        'Content-Encoding': 'gzip',
        'Content-Disposition': `inline; filename="${base}"`,
        'Cache-Control': 'public, max-age=60'
      }
    });
  } catch (e) {
    console.error('Error:', e);
    return new Response(`# Error: ${e.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}