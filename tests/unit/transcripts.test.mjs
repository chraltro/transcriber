import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../transcripts.mjs';

const turns = (html) => parseTranscript(html).map((t) => `${t.speaker}|${t.text.slice(0, 12)}`);

test('CWT and 80,000 Hours style: NAME: text, continuation paragraphs', () => {
  const html = '<p>Recorded in May.</p>' + [1, 2, 3, 4].map((i) => `<p><strong>COWEN:</strong> Question ${i} here please?</p><p><strong>KLEIN:</strong> Answer ${i} goes here.</p><p>More of answer ${i} follows.</p>`).join('') + '<p><strong>TYLER COWEN:</strong> Thanks a lot.</p>';
  const t = parseTranscript(html);
  assert.equal(t.length, 9);
  assert.equal(t[1].speaker, 'KLEIN');
  assert.match(t[1].text, /More of answer 1/);
  assert.equal(t[8].speaker, 'TYLER COWEN');
  assert.equal(t[0].speaker, 'TYLER COWEN'); // COWEN and TYLER COWEN are one person
});

test('NPR style: NAME, ROLE: text', () => {
  const html = [1, 2, 3, 4].map((i) => `<p>TERRY GROSS, HOST: This is turn ${i}.</p><p>ANNA BERG: Reply ${i} is here.</p>`).join('');
  assert.deepEqual(turns(html).slice(0, 2), ['TERRY GROSS|This is turn', 'ANNA BERG|Reply 1 is h']);
});

test('Lex and Dwarkesh style: name with a timestamp, text after or below', () => {
  const lex = [1, 2, 3, 4].map((i) => `<div><span>Lex Fridman</span><span>(00:0${i}:00)</span> <span>Question number ${i} for you.</span></div><div><span>Jane Doe</span><span>(00:0${i}:30)</span> <span>Answer number ${i} from me.</span></div>`).join('');
  assert.deepEqual(turns(lex).slice(0, 2), ['LEX FRIDMAN|Question num', 'JANE DOE|Answer numbe']);
  const dw = [1, 2, 3, 4].map((i) => `<p><strong>Dwarkesh Patel</strong> <em>00:0${i}:00</em></p><p>Question number ${i} for you.</p><p><strong>Jane Doe</strong> <em>00:0${i}:30</em></p><p>Answer number ${i} from me.</p>`).join('');
  assert.deepEqual(turns(dw).slice(0, 2), ['DWARKESH PATEL|Question num', 'JANE DOE|Answer numbe']);
});

test('a label used once is text, not a speaker', () => {
  const html = '<p>Note: this is not a speaker.</p>' + [1, 2, 3, 4].map((i) => `<p>HOST: Line ${i} is here.</p><p>GUEST: Line ${i} back.</p>`).join('');
  assert.ok(!parseTranscript(html).some((t) => t.speaker === 'NOTE'));
});
