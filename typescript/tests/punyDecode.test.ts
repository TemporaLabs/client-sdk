// What the Punycode decoder behind the uri host check gives for a label. The expected text is Python's `punycode`
// codec's decoding of the same label, so the decoder is checked against an independent implementation. The samples are
// those of RFC 3492 section 7.1, lower-cased as a URL parser writes a host, plus a few short real labels.
import { punyDecode } from '../src/internal'

const DECODED: Record<string, string> = {
  egbpdaj6bu4bxfgehfvwxn: 'ليهمابتكلموشعربي؟',
  ihqwcrb4cv8a8dqg056pqjye: '他们为什么不说中文',
  ihqwctvzc91f659drss3x8bo0yb: '他們爲什麽不說中文',
  'proprostnemluvesky-uyb24dma41a': 'pročprostěnemluvíčesky',
  '4dbcagdahymbxekheh6e0a7fei0b': 'למההםפשוטלאמדבריםעברית',
  i1baa7eci9glrd9b2ae1bj0hfcgg6iyaf8o0a1dig0cd: 'यहलोगहिन्दीक्योंनहींबोलसकतेहैं',
  n8jok5ay5dzabd5bym9f0cm5685rrjetr6pdxa: 'なぜみんな日本語を話してくれないのか',
  b1abfaaepdrnnbgefbadotcwatmq2g4l: 'почемужеонинеговорятпорусски',
  'porqunopuedensimplementehablarenespaol-fmd56a': 'porquénopuedensimplementehablarenespañol',
  'tisaohkhngthchnitingvit-kjcr8268qyxafd2f1b9g': 'tạisaohọkhôngthểchỉnóitiếngviệt',
  '3b-ww4c5e180e575a65lsy2b': '3年b組金八先生',
  '-with-super-monkeys-pc58ag80a8qai00g7n9n': '安室奈美恵-with-super-monkeys',
  'hello-another-way--fc4qua05auwb3674vfr0b': 'hello-another-way-それぞれの場所',
  '2-u9tlzr9756bt3uc0v': 'ひとつ屋根の下2',
  'majiko-ib4i84k': '䶤m䮸ajiko',
  'de-jg4avhby1noc0d': 'パフィーdeルンバ',
  d9juau41awczczp: 'そのスピードで',
  'bcher-kva': 'bücher',
  ls8h: '💩',
  nxasmq6b: 'βόλοσ',
  '4kq': '二',
  // A long first delta, where the damping of RFC 3492 section 6.1 (700) decides the bias.
  '2abbagh2iia-efj14cl8a45mx9b2b5v08bla2944tugaok6incp20979fu2uayj2cvo5evszaky28q5cca0zdbn': '\u06032\u3089\u0452\u3097\ub0e3\u06e5a\u3072b\u0689b\ubbbbagh\u0685\uccfa\u3096\u06e4\ud83c\udf5e\uc9092\u04a0\u307c\u069d\u3093\u0425ii\ub471\ud83c\udfab\ud83c\udffaa\ud83d\udc07',
  // Valid Punycode whose text is control characters: the host check refuses these because the URL parser does.
  abc: '\x82\x81\x80',
  a: '\x80',
}

describe('the Punycode decoder', () => {
  it.each(Object.entries(DECODED))('decodes %s', (label, text) => expect(punyDecode(label)).toBe(text))
  it.each(['', 'zzzzzzzzz', '99999999999999', 'ab$', 'a-b-$'])('gives null for %j, which is not valid Punycode', (label) => expect(punyDecode(label)).toBeNull())
})
