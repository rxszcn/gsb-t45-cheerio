// 复现：同一份表格片段，十一个插入入口与 html() 造出两棵树，前者存盘再读回来结构还会自己变
import { describe, it } from 'vitest';
import { load } from '../src/index.js';

describe('现状', () => {
  it('打出全部现状', () => {
    const F = '<td>a</td>';
    type Api = (fn: ReturnType<typeof load>) => void;
    const apis: [string, Api][] = [
      ['append', ($) => $('#b').append(F)],
      ['prepend', ($) => $('#b').prepend(F)],
      ['before', ($) => $('#b').before(F)],
      ['after', ($) => $('#b').after(F)],
      ['appendTo', ($) => $(F).appendTo('#b')],
      ['prependTo', ($) => $(F).prependTo('#b')],
      ['insertBefore', ($) => $(F).insertBefore('#b')],
      ['insertAfter', ($) => $(F).insertAfter('#b')],
      ['replaceWith', ($) => $('#b').replaceWith(F)],
      ['wrap', ($) => $('#b').wrap('<i></i>')],
      ['wrapInner', ($) => $('#b').wrapInner(F)],
      ['html(setter)', ($) => $('#b').html(F)],
    ];
    for (const [name, api] of apis) {
      const $ = load('<table id=t><tbody id=b></tbody></table>');
      api($);
      const flat = $.html();
      const round = load(flat).html();
      console.log(name.padEnd(16), 'rows:', String($('#b > tr').length), 'stable:', flat === round ? 'yes' : 'NO');
    }
  });
});
