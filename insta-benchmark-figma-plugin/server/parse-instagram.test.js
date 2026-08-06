const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInstagramHtml, extractAuthor } = require('./parse-instagram');

test('단일 이미지 게시물에서 이미지/캡션/작성자를 추출한다', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="benchmarkuser on Instagram: &quot;오늘의 레이아웃&quot;" />
      <meta property="og:description" content="좋아요 1,234개 - benchmarkuser님의 게시물" />
      <meta property="og:image" content="https://scontent.cdninstagram.com/single.jpg" />
    </head><body></body></html>
  `;
  const result = parseInstagramHtml(html);
  assert.deepEqual(result.images, ['https://scontent.cdninstagram.com/single.jpg']);
  assert.equal(result.author, 'benchmarkuser');
  assert.match(result.caption, /좋아요/);
});

test('캐러셀 게시물에서 display_url을 모두 추출한다', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="creator on Instagram" />
      <meta property="og:image" content="https://scontent.cdninstagram.com/cover.jpg" />
    </head><body>
      <script>
        window.__data = {"items":[
          {"display_url":"https:\\/\\/scontent.cdninstagram.com\\/slide1.jpg"},
          {"display_url":"https:\\/\\/scontent.cdninstagram.com\\/slide2.jpg"}
        ]};
      </script>
    </body></html>
  `;
  const result = parseInstagramHtml(html);
  assert.deepEqual(result.images, [
    'https://scontent.cdninstagram.com/slide1.jpg',
    'https://scontent.cdninstagram.com/slide2.jpg',
  ]);
});

test('og:image가 없으면 NO_IMAGE_FOUND 에러를 던진다', () => {
  const html = '<html><head></head><body>삭제된 게시물</body></html>';
  assert.throws(() => parseInstagramHtml(html), /NO_IMAGE_FOUND/);
});

test('extractAuthor는 "X on Instagram" 패턴에서 계정명을 뽑는다', () => {
  assert.equal(extractAuthor('cool.user on Instagram: "caption"'), 'cool.user');
  assert.equal(extractAuthor(null), null);
});
