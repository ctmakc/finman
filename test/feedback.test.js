// test/feedback.test.js — POST /api/feedback + team inbox (routes/feedback.js).
//
//   - validation: kind, trigger, rating 1..5, empty answers, bug/idea need words;
//   - signed in → user_id kept; anonymous exit survey accepted;
//   - "test…" comment → is_test=1; survey answered once per trigger;
//   - /api/feedback/admin only for ADMIN_EMAILS (404 for everybody else), PATCH/DELETE;
//   - deleting the account keeps the exit survey without the user id;
//   - /api/auth/me tells the client whether the person is on the team.
process.env.ADMIN_EMAILS = 'boss@finman-team.example';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { makeApp } = require('./helpers/app');

let ctx, db, config;

async function mkUser(name, email) {
  const r = await db.run(
    'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
    [name, email || `${name}@example.com`, await bcrypt.hash('password123', 4)]
  );
  return { id: r.id, token: jwt.sign({ id: r.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' }) };
}
const post = (body, token) => {
  const r = ctx.request.post('/api/feedback').send(body);
  return token ? r.set('Authorization', 'Bearer ' + token) : r;
};
const auth = (req, token) => req.set('Authorization', 'Bearer ' + token);

let alice, boss;
beforeAll(async () => {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
  alice = await mkUser('alice');
  boss = await mkUser('boss', 'boss@finman-team.example');
});
afterAll(async () => { await ctx.close(); });

describe('POST /api/feedback — validation', () => {
  test('unknown kind / trigger / rating are refused', async () => {
    expect((await post({ kind: 'spam', comment: 'hello' }, alice.token)).status).toBe(400);
    expect((await post({ kind: 'rating', trigger: 'nowhere', rating: 4 }, alice.token)).status).toBe(400);
    expect((await post({ kind: 'rating', rating: 6 }, alice.token)).status).toBe(400);
    expect((await post({ kind: 'rating', rating: 2.5 }, alice.token)).status).toBe(400);
  });
  test('an answer with nothing in it is refused', async () => {
    const r = await post({ kind: 'rating' }, alice.token);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('empty');
  });
  test('bug and idea need a few words', async () => {
    expect((await post({ kind: 'bug', rating: 3 }, alice.token)).status).toBe(400);
    expect((await post({ kind: 'idea', comment: 'ok' }, alice.token)).status).toBe(400);
  });
});

describe('POST /api/feedback — storing', () => {
  test('signed-in rating keeps the user id and the comment is capped', async () => {
    const r = await post({ kind: 'rating', trigger: 'menu', rating: 4, comment: 'x'.repeat(2500), page: '/dashboard' }, alice.token);
    expect(r.status).toBe(201);
    const row = await db.get('SELECT * FROM feedback WHERE id = ?', [r.body.id]);
    expect(row.user_id).toBe(alice.id);
    expect(row.rating).toBe(4);
    expect(row.comment.length).toBe(2000);
    expect(row.is_test).toBe(0);
    expect(row.status).toBe('new');
  });
  test('a comment that starts with "test" is a test', async () => {
    const r = await post({ kind: 'bug', comment: 'TEST import button does nothing' }, alice.token);
    const row = await db.get('SELECT is_test FROM feedback WHERE id = ?', [r.body.id]);
    expect(row.is_test).toBe(1);
  });
  test('an exit survey without sign-in is accepted with no user', async () => {
    const r = await post({ kind: 'exit', trigger: 'account_delete', answer: 'privacy' });
    expect(r.status).toBe(201);
    const row = await db.get('SELECT user_id, answer FROM feedback WHERE id = ?', [r.body.id]);
    expect(row.user_id).toBeNull();
    expect(row.answer).toBe('privacy');
  });
  test('a broken token is treated as anonymous', async () => {
    const r = await post({ kind: 'exit', trigger: 'account_delete', answer: 'other' }, 'nope');
    expect(r.status).toBe(201);
  });
  test('a survey is answered once per trigger', async () => {
    const a = await post({ kind: 'survey', trigger: 'import_done', rating: 5 }, alice.token);
    const b = await post({ kind: 'survey', trigger: 'import_done', rating: 1 }, alice.token);
    expect(a.status).toBe(201);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    const mine = await auth(ctx.request.get('/api/feedback/mine?trigger=import_done'), alice.token);
    expect(mine.body.answered).toBe(true);
    const other = await auth(ctx.request.get('/api/feedback/mine?trigger=day7'), alice.token);
    expect(other.body.answered).toBe(false);
  });
});

describe('team inbox', () => {
  test('/api/auth/me says who is on the team', async () => {
    expect((await auth(ctx.request.get('/api/auth/me'), alice.token)).body.isAdmin).toBe(false);
    expect((await auth(ctx.request.get('/api/auth/me'), boss.token)).body.isAdmin).toBe(true);
  });
  test('everyone outside ADMIN_EMAILS gets 404', async () => {
    expect((await auth(ctx.request.get('/api/feedback/admin'), alice.token)).status).toBe(404);
    expect((await ctx.request.get('/api/feedback/admin')).status).toBe(401);
    expect((await auth(ctx.request.patch('/api/feedback/admin/1').send({ status: 'done' }), alice.token)).status).toBe(404);
    expect((await auth(ctx.request.delete('/api/feedback/admin/1'), alice.token)).status).toBe(404);
  });
  test('admin lists without tests by default, with stats; can mark and delete', async () => {
    const list = await auth(ctx.request.get('/api/feedback/admin'), boss.token);
    expect(list.status).toBe(200);
    expect(list.body.items.every((i) => i.is_test === 0)).toBe(true);
    expect(list.body.stats.total).toBe(list.body.items.length);
    const withTests = await auth(ctx.request.get('/api/feedback/admin?tests=1'), boss.token);
    expect(withTests.body.items.length).toBeGreaterThan(list.body.items.length);
    const exits = await auth(ctx.request.get('/api/feedback/admin?kind=exit'), boss.token);
    expect(exits.body.items.every((i) => i.kind === 'exit')).toBe(true);
    expect(exits.body.answers.some((a) => a.answer === 'privacy')).toBe(true);

    const id = list.body.items[0].id;
    expect((await auth(ctx.request.patch(`/api/feedback/admin/${id}`).send({ status: 'bogus' }), boss.token)).status).toBe(400);
    expect((await auth(ctx.request.patch(`/api/feedback/admin/${id}`).send({ status: 'done' }), boss.token)).status).toBe(200);
    expect((await db.get('SELECT status FROM feedback WHERE id = ?', [id])).status).toBe('done');
    expect((await auth(ctx.request.delete(`/api/feedback/admin/${id}`), boss.token)).status).toBe(200);
    expect(await db.get('SELECT id FROM feedback WHERE id = ?', [id])).toBeUndefined();
    expect((await auth(ctx.request.delete(`/api/feedback/admin/${id}`), boss.token)).status).toBe(404);
  });
});

describe('account deletion', () => {
  test('the exit survey stays, without the user id', async () => {
    const carol = await mkUser('carol');
    const r = await post({ kind: 'exit', trigger: 'account_delete', answer: 'bank', comment: 'no Tangerine' }, carol.token);
    expect(r.status).toBe(201);
    expect((await db.get('SELECT user_id FROM feedback WHERE id = ?', [r.body.id])).user_id).toBe(carol.id);
    const del = await auth(ctx.request.delete('/api/auth/me').send({ confirm: 'DELETE', password: 'password123' }), carol.token);
    expect(del.status).toBe(200);
    const row = await db.get('SELECT user_id, answer, comment FROM feedback WHERE id = ?', [r.body.id]);
    expect(row).toEqual({ user_id: null, answer: 'bank', comment: 'no Tangerine' });
    expect(await db.get('SELECT id FROM users WHERE id = ?', [carol.id])).toBeUndefined();
  });
});
