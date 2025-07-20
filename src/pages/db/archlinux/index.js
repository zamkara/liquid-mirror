export async function GET() {
  const baseUrl = '/db/archlinux/';
  const staticFiles = [
    'liquid.db',
    'liquid.db.sig',
    'liquid.files',
    'liquid.files.sig'
  ];

  let packages = [];
  let lastModified = new Date().toUTCString();

  try {
    // Try direct API access first
    let apiUrl = 'https://liquid.zamkara.tech/api/latest';
    let response = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' }
    });

    // If direct access fails, try through CORS proxy
    if (!response.ok) {
      apiUrl = 'https://cors.zamkara.tech/?https://liquid.zamkara.tech/api/latest';
      response = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json' }
      });
    }

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) {
        packages = data
          .filter(item => item.name && item.version)
          .filter(item => item.name.endsWith('.pkg.tar.zst') || item.distro === 'pkg.tar.zst')
          .map(item => ({
            name: item.name,
            version: item.version,
            size: item.size || '0B',
            url: `https://github.com/liquidprjkt/liquid_kernel_desktop_x86/releases/download/${item.version}/${item.name}`,
            date: item.date || new Date().toISOString().split('T')[0]
          }));
        
        lastModified = response.headers.get('last-modified') || lastModified;
      }
    }
  } catch (error) {
    console.error('Error fetching packages:', error);
  }

  // Group packages by version
  const versionGroups = packages.reduce((groups, pkg) => {
    if (!groups[pkg.version]) groups[pkg.version] = [];
    groups[pkg.version].push(pkg);
    return groups;
  }, {});

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Arch Linux Repository - ${baseUrl}</title>
  <style>
    body { font-family: monospace; max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { border-bottom: 1px solid #ddd; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .nav-up { display: inline-block; margin-bottom: 15px; }
    .section { margin: 20px 0 10px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="nav-up"><a href="../">↑ Parent Directory</a></div>
  <h1>Index of ${baseUrl}</h1>
  <p>Last updated: ${lastModified}</p>

  <div class="section">Repository Metadata</div>
  <table>
    <tr><th>Filename</th><th>Size</th><th>Date</th></tr>
    ${staticFiles.map(file => `
      <tr>
        <td><a href="${baseUrl + file}">${file}</a></td>
        <td>-</td>
        <td>${lastModified.split(', ')[1]}</td>
      </tr>
    `).join('')}
  </table>

  ${Object.entries(versionGroups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([version, pkgs]) => `
      <div class="section">Version ${version}</div>
      <table>
        <tr><th>Package</th><th>Size</th><th>Date</th></tr>
        ${pkgs.map(pkg => `
          <tr>
            <td><a href="${pkg.url}">${pkg.name}</a></td>
            <td>${pkg.size}</td>
            <td>${pkg.date}</td>
          </tr>
        `).join('')}
      </table>
    `).join('')}

  ${packages.length === 0 ? `
    <div class="section">No Packages Found</div>
    <p>The repository currently contains no Arch Linux packages.</p>
  ` : ''}

  <p>Generated at: ${new Date().toUTCString()}</p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Last-Modified': lastModified
    }
  });
}