// src/pages/db/archlinux/generator.js
import { gzip } from 'pako';
import { createHash } from 'node:crypto';

const REPO_CONFIG = {
  owner: "liquidprjkt",
  repo: "liquid_kernel_desktop_x86",
  token: import.meta.env.GITHUB_TOKEN,
  maxPackages: 3,
  architectures: ['x86_64'],
  packagePatterns: [
    /^linux-upstream-(\d+\.\d+\.\d+_liquid-\d+)-(x86_64)\.pkg\.tar\.zst$/,
    /^linux-upstream-(rt|zen|lts)-(\d+\.\d+\.\d+_liquid-\d+)-(x86_64)\.pkg\.tar\.zst$/
  ]
};

class RepositoryGenerator {
  constructor() {
    if (!REPO_CONFIG.token) {
      throw new Error('GITHUB_TOKEN environment variable is not set');
    }
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  async #fetchReleases() {
    const response = await fetch(
      `https://api.github.com/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/releases`,
      {
        headers: {
          'Authorization': `Bearer ${REPO_CONFIG.token}`,
          'User-Agent': 'ArchLinux-Repo-Generator',
          'Accept': 'application/vnd.github+json'
        }
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorBody}`);
    }

    return await response.json();
  }

 #validatePackage(asset) {
  return REPO_CONFIG.packagePatterns.some(pattern => 
    pattern.test(asset.name) && 
    REPO_CONFIG.architectures.some(arch => 
      asset.name.endsWith(`${arch}.pkg.tar.zst`)
    )
  );
}

  #parsePackageInfo(asset, release) {
    for (const pattern of REPO_CONFIG.packagePatterns) {
      const match = asset.name.match(pattern);
      if (match) {
        const [_, variant, version, arch] = match;
        return {
          name: variant ? `linux-upstream-${variant}` : 'linux-upstream',
          variant: variant || 'default',
          version,
          arch,
          filename: asset.name,
          size: asset.size,
          downloadUrl: asset.browser_download_url,
          publishedAt: new Date(release.published_at),
          releaseTag: release.tag_name
        };
      }
    }
    return null;
  }

  #generateDescContent(pkg) {
    const buildDate = Math.floor(pkg.publishedAt.getTime() / 1000);
    const provides = pkg.variant === 'default' ? [] : [`linux-upstream=${pkg.version}`];
    
    return [
      '%FILENAME%',
      pkg.filename,
      '%NAME%',
      pkg.name,
      '%BASE%',
      pkg.name,
      '%VERSION%',
      pkg.version,
      '%DESC%',
      'Liquid Kernel for Arch Linux',
      '%GROUPS%',
      'linux-upstream',
      '%URL%',
      `https://github.com/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}`,
      '%LICENSE%',
      'GPL2',
      '%ARCH%',
      pkg.arch,
      '%PROVIDES%',
      provides.join('\n') || '',
      '%DEPENDS%',
      'linux-firmware',
      '%OPTDEPENDS%',
      'wireless-regdb: to set the correct wireless channels of your country',
      '%CONFLICTS%',
      'linux',
      '%REPLACES%',
      'linux',
      '%BUILDDATE%',
      buildDate,
      '%PACKAGER%',
      'Liquid Mirror <hi@zamkara.tech>',
      '%SIZE%',
      pkg.size,
      ''
    ].join('\n');
  }

  #generateFilesContent(pkg) {
    const kernelVersion = pkg.version.replace(/_/g, '.');
    const files = [
      `.${pkg.filename}`,
      `/usr/lib/modules/${kernelVersion}/vmlinuz`,
      `/usr/lib/modules/${kernelVersion}/build`,
      `/usr/lib/modules/${kernelVersion}/kernel`,
      `/boot/initramfs-${kernelVersion}.img`,
      `/boot/System.map-${kernelVersion}`
    ];

    if (pkg.variant === 'default') {
      files.push(
        `/boot/vmlinuz-${kernelVersion}`,
        `/usr/src/linux-${kernelVersion}`
      );
    }

    return files.join('\n') + '\n';
  }

  #makeTarHeader(name, size, options = {}) {
    const buf = new Uint8Array(512);
    const write = (offset, str, length) => {
      const data = this.encoder.encode(str);
      buf.set(data.slice(0, length), offset);
    };

    // Format header sesuai spesifikasi tar POSIX ustar
    write(0, name.padEnd(100, '\0'), 100);       // name
    write(100, '000644\0', 8);                   // mode
    write(108, '000000\0', 8);                   // uid
    write(116, '000000\0', 8);                   // gid
    write(124, size.toString(8).padStart(11, '0') + '\0', 12); // size
    write(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 12); // mtime
    write(148, '        ', 8);                   // checksum (placeholder)
    write(156, options.type || '0', 1);          // typeflag
    write(257, 'ustar\0', 6);                    // magic
    write(263, '00', 2);                         // version

    // Hitung checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    write(148, sum.toString(8).padStart(6, '0') + '\0 ', 8);

    return buf;
  }

  #buildTarArchive(files) {
    const blocks = [];
    
    for (const file of files) {
      // Header
      const header = this.#makeTarHeader(
        file.name,
        file.content.length,
        { type: file.type || '0' }
      );
      blocks.push(header);
      
      // Konten
      blocks.push(file.content);
      
      // Padding
      const padSize = (512 - (file.content.length % 512)) % 512;
      if (padSize > 0) {
        blocks.push(new Uint8Array(padSize));
      }
    }
    
    // Akhir archive (2 block kosong)
    blocks.push(new Uint8Array(1024));
    
    // Gabungkan semua block
    const totalSize = blocks.reduce((sum, block) => sum + block.length, 0);
    const tarData = new Uint8Array(totalSize);
    let offset = 0;
    for (const block of blocks) {
      tarData.set(block, offset);
      offset += block.length;
    }
    
    return tarData;
  }

  #generateDummySignature() {
    const sig = new Uint8Array(512);
    crypto.getRandomValues(sig);
    return sig;
  }

  async generateDatabase() {
    try {
      const releases = await this.#fetchReleases();
      const packages = [];
      
      // Kumpulkan semua package valid
      for (const release of releases) {
        if (release.draft) continue;
        
        for (const asset of release.assets || []) {
          if (this.#validatePackage(asset)) {
            const pkg = this.#parsePackageInfo(asset, release);
            if (pkg) packages.push(pkg);
          }
        }
      }
      
      // Urutkan berdasarkan tanggal (terbaru pertama)
      packages.sort((a, b) => b.publishedAt - a.publishedAt);
      
      // Ambil yang terbaru saja
      const latestPackages = packages.slice(0, REPO_CONFIG.maxPackages);
      
      // Siapkan entri database
      const dbEntries = [];
      const filesEntries = [];
      
      for (const pkg of latestPackages) {
        const dirName = `${pkg.name}-${pkg.version}-${pkg.arch}`;
        
        // Entri untuk desc
        dbEntries.push({
          name: `${dirName}/desc`,
          content: this.encoder.encode(this.#generateDescContent(pkg))
        });
        
        // Entri untuk files
        filesEntries.push({
          name: `${dirName}/files`,
          content: this.encoder.encode(this.#generateFilesContent(pkg))
        });
        
        // Entri untuk depends (jika diperlukan)
        dbEntries.push({
          name: `${dirName}/depends`,
          content: this.encoder.encode(this.#generateDependsContent(pkg))
        });
      }
      
      // Bangun archive tar
      const dbTar = this.#buildTarArchive(dbEntries);
      const filesTar = this.#buildTarArchive(filesEntries);
      
      return {
        'liquid.db': gzip(dbTar),
        'liquid.db.sig': this.#generateDummySignature(),
        'liquid.files': gzip(filesTar),
        'liquid.files.sig': this.#generateDummySignature(),
        packages: latestPackages
      };
      
    } catch (error) {
      console.error('Database generation failed:', error);
      throw error;
    }
  }
  
  #generateDependsContent(pkg) {
    return [
      'linux-firmware',
      'wireless-regdb',
      ''
    ].join('\n');
  }
}

export const generator = new RepositoryGenerator();

export async function GET({ request }) {
  const url = new URL(request.url);
  const isDb = url.pathname.endsWith('.db');
  const isFiles = url.pathname.endsWith('.files');
  const isSig = url.pathname.endsWith('.sig');
  
  try {
    const { 
      'liquid.db': dbData, 
      'liquid.db.sig': dbSig,
      'liquid.files': filesData,
      'liquid.files.sig': filesSig 
    } = await generator.generateDatabase();
    
    if (isSig) {
      return new Response(
        isDb ? dbSig : filesSig,
        {
          headers: {
            'Content-Type': 'application/pgp-signature',
            'Cache-Control': 'public, max-age=31536000' // 1 year
          }
        }
      );
    }
    
    return new Response(
      isDb ? dbData : filesData,
      {
        headers: {
          'Content-Type': isDb 
            ? 'application/vnd.pacman.db' 
            : 'application/vnd.pacman.files',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300' // 5 minutes
        }
      }
    );
    
  } catch (error) {
    return new Response(
      `Error generating repository: ${error.message}`,
      {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      }
    );
  }
}