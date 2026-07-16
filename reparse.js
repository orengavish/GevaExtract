// Re-parses all posts in DB into the lines table. Safe to re-run.
// Usage: node reparse.js
const { openDb } = require('./db');
const { parseLinesFromPost } = require('./parse-lines');

async function main() {
  const db    = await openDb();
  const posts = db.getAllPosts();
  console.log(`Reparsing ${posts.length} posts...`);

  for (const post of posts) {
    const lines = parseLinesFromPost({
      date: post.date,
      support: post.support,
      resistance: post.resistance,
    });
    // upsertPost triggers line parsing automatically — but we use internal
    // access here since we only want to repopulate lines, not touch the post row.
    // So we call upsertPost with the minimal fields it needs.
    db.upsertPost({
      date:       post.date,
      day:        post.day,
      support:    post.support,
      resistance: post.resistance,
      fullText:   post.full_text,
      postUrl:    post.post_url,
      capturedAt: post.captured_at,
      source:     post.source,
    });
    console.log(`  ${post.date}: ${lines.length} lines`);
  }

  db.save();
  db.close();
  console.log('Done.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
