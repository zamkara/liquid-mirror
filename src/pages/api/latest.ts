interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

interface MirrorFile {
  version: string;
  name: string;
  size: string;
  url: string;
  distro?: 'deb' | 'rpm' | 'pkg' | 'raw'; // Optional distro type for filtering
}

export async function GET() {
  try {
    const response = await fetch(
      'https://api.github.com/repos/liquidprjkt/liquid_kernel_desktop_x86/releases',
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'liquid-kernel-mirror',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const releases: GitHubRelease[] = await response.json();

    const files: MirrorFile[] = releases.flatMap((release) =>
      release.assets.map((asset: GitHubAsset) => {
        // Detect distro type from filename
        const distro = asset.name.match(/\.(deb|rpm|pkg\.tar\.zst)/)?.[1] as 'deb' | 'rpm' | 'pkg' | undefined;
        
        return {
          version: release.tag_name,
          name: asset.name,
          size: `${(asset.size / 1024 / 1024).toFixed(1)} MB`,
          url: asset.browser_download_url,
          ...(distro && { distro })
        };
      })
    );

    return new Response(JSON.stringify(files, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=300' // 5min cache
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}