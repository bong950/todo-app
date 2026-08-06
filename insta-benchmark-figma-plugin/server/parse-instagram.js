function extractMetaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) {
      return match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    }
  }
  return null;
}

function extractCarouselImages(html) {
  const matches = [...html.matchAll(/"display_url":"([^"]+)"/g)];
  const urls = matches.map((m) => m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
  return [...new Set(urls)];
}

function extractAuthor(ogTitle) {
  if (!ogTitle) return null;
  const match = ogTitle.match(/^(.+?)\s+on Instagram/i);
  return match ? match[1].trim() : null;
}

function parseInstagramHtml(html) {
  const primaryImage = extractMetaContent(html, 'og:image');
  if (!primaryImage) {
    throw new Error('NO_IMAGE_FOUND');
  }

  const caption = extractMetaContent(html, 'og:description') || '';
  const ogTitle = extractMetaContent(html, 'og:title');
  const author = extractAuthor(ogTitle) || 'unknown';

  const carousel = extractCarouselImages(html);
  const images = carousel.length > 0 ? carousel : [primaryImage];

  return { images, caption, author };
}

module.exports = { parseInstagramHtml, extractMetaContent, extractCarouselImages, extractAuthor };
