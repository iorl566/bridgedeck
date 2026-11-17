// DOMSnapshot 事实解码：几何 / 可见性 / 可点击 / 计算样式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSnapshotFacts, decodeVomIds, FACTS_STYLES } from '../../extension/src/dom-snapshot.js';

function snapshotFixture() {
  // strings: 0:none 1:block 2:0 3:1 4:visible 5:hidden 6:auto 7:''
  const strings = ['none', 'block', '0', '1', 'visible', 'hidden', 'auto', ''];
  const styles = (display, visibility, opacity) => {
    const row = [];
    row[0] = display; // display
    row[1] = visibility; // visibility
    row[2] = opacity; // opacity
    row[3] = 6; // pointer-events: auto
    for (let i = 4; i < FACTS_STYLES.length; i += 1) row[i] = 7;
    return row;
  };
  return {
    strings,
    documents: [{
      nodes: {
        backendNodeId: [101, 102, 103],
        isClickable: { index: [1] },
      },
      layout: {
        nodeIndex: [0, 1, 2],
        bounds: [
          [0, 0, 100, 50],
          [10, 10, 0, 0],
          [0, 0, 20, 20],
        ],
        styles: [
          styles(1, 4, 3),
          styles(1, 4, 3),
          styles(0, 4, 3),
        ],
        paintOrders: [5, 6, 7],
      },
    }],
  };
}

test('解码 bounds / 可见性 / 可点击 / 样式', () => {
  const facts = decodeSnapshotFacts(snapshotFixture());
  assert.equal(facts.size, 3);
  const normal = facts.get(101);
  assert.deepEqual(normal.bounds, { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(normal.visible, true);
  assert.equal(normal.clickable, false);
  assert.equal(normal.styles.display, 'block');
  assert.equal(normal.styles.visibility, 'visible');
  assert.equal(normal.styles['pointer-events'], 'auto');
  assert.equal(normal.paintOrder, 5);

  const zeroArea = facts.get(102);
  assert.equal(zeroArea.visible, false, '零面积不可见');
  assert.equal(zeroArea.clickable, true, 'isClickable 命中');

  const hidden = facts.get(103);
  assert.equal(hidden.visible, false, 'display:none 不可见');
});

test('缺少 documents/layout 时返回空 Map', () => {
  assert.equal(decodeSnapshotFacts(null).size, 0);
  assert.equal(decodeSnapshotFacts({ strings: [] }).size, 0);
  assert.equal(decodeSnapshotFacts({ documents: [{}] }).size, 0);
});

test('decodeVomIds 从 DOMSnapshot 属性解析 data-bb-vom', () => {
  const snapshot = {
    strings: ['data-bb-vom', 'v1', 'v2', 'x'],
    documents: [{
      nodes: {
        backendNodeId: [101, 102, 103],
        attributes: [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
      },
    }],
  };
  const map = decodeVomIds(snapshot);
  assert.equal(map.get('v1'), 101);
  assert.equal(map.get('v2'), 102);
  assert.equal(map.get('x'), 103);
  assert.equal(decodeVomIds(null).size, 0);
});

test('解码表单值 / checked / selected，并遮蔽密码', () => {
  // strings: 0:'' 1:'input' 2:'type' 3:'password' 4:'text' 5:'data-bb-vom' 6:'v1'
  const strings = ['', 'input', 'type', 'password', 'text', 'data-bb-vom', 'v1'];
  const snapshot = {
    strings,
    documents: [{
      nodes: {
        backendNodeId: [1, 2, 3],
        nodeName: [1, 1, 1],
        attributes: [
          [2, 4], // type=text
          [2, 3], // type=password
          [5, 6], // data-bb-vom=v1
        ],
        inputValue: { index: [0, 1], value: [0, 4] },
        inputChecked: { index: [1] },
        optionSelected: { index: [1] },
      },
      layout: {
        nodeIndex: [0, 1, 2],
        bounds: [[0, 0, 10, 10], [0, 0, 10, 10], [0, 0, 10, 10]],
        styles: [[], [], []],
      },
    }],
  };
  const facts = decodeSnapshotFacts(snapshot);
  assert.equal(facts.get(1).value, '');
  assert.equal(facts.get(1).checked, undefined);
  assert.equal(facts.get(2).value, '********');
  assert.equal(facts.get(2).checked, true);
  assert.equal(facts.get(2).selected, true);
  assert.equal(facts.get(3).value, undefined);
});

test('autocomplete 敏感字段遮蔽', () => {
  const strings = ['autocomplete', 'one-time-code', 'input', '123456'];
  const snapshot = {
    strings,
    documents: [{
      nodes: {
        backendNodeId: [1],
        nodeName: [2],
        attributes: [[0, 1]],
        inputValue: { index: [0], value: [3] },
      },
      layout: { nodeIndex: [0], bounds: [[0, 0, 10, 10]], styles: [[]] },
    }],
  };
  const facts = decodeSnapshotFacts(snapshot);
  assert.equal(facts.get(1).value, '********');
});
