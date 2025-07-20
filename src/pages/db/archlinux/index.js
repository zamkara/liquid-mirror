export async function GET() {
  const base = '/db/archlinux/';
  const files = [
    'liquid.db',
    'liquid.db.sig',
    'liquid.files',
    'liquid.files.sig',
  ];

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Index of ${base}</title>
  <style>
    body {
      font-family: monospace;
      padding: 2rem;
    }
    h1 {
      margin-bottom: 1rem;
    }
    a {
      color: #1e88e5;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .listing {
      margin-top: 1rem;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <h1>Index of ${base}</h1>
  <div class="listing">
    ${files.map(file => `<a href="${base + file}">${file}</a>`).join('<br />')}
  </div>
</body>
</html>
`.trim();

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}
