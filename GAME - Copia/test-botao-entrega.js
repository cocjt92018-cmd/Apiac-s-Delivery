// Harness temporário: extrai as funções REAIS do app.js e testa o fluxo do botão "Entregar pedido" (Saiu para entrega).
const fs = require('fs');
const lines = fs.readFileSync('d:/DOCUMENTOS/Documents/GAME/app.js', 'utf8').split(/\r?\n/);
const seg = (a, b) => lines.slice(a - 1, b).join('\n');

const realFns = [
  seg(225, 225),    // normalizeEmail
  seg(471, 475),    // isAdminPreview / isCustomerView / isMasterSession / isCommerceSession / getActiveCommerceId
  seg(851, 858),    // getSavedOrders
  seg(1466, 1479),  // getAdminOrders
  seg(1590, 1593),  // saveAdminOrders
  seg(1717, 1743),  // updateAdminOrderStatus
  seg(1756, 1767),  // confirmClientOrderDelivery
  seg(1855, 1859),  // isCurrentCustomerOrder
].join('\n');

// Mapeamento EXATO do handler de clique (linha 1822) e das condições de render (1808-1810), verbatim:
const clickMapping = seg(1822, 1822);
const renderCond = seg(1808, 1810);

function makeEnv({ profile = 'commerce', commerceId = '1', user = { id: 'u1', email: 'cliente@teste.com' }, orders = [], activeOrderFilter = 'active' } = {}) {
  const store = new Map();
  store.set('apiacasDeliveryOrders', JSON.stringify(orders));
  const localStorageMock = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  const calls = { status: [], renders: 0, cancelOpens: [] };
  const documentMock = { querySelectorAll: () => [] };
  const fn = new Function(
    'localStorage', 'document', 'window',
    'showStatus', 'renderAdminOrders', 'openCancelOrderConfirmation',
    'currentUser', 'currentProfile', 'currentCommerceId', 'adminPreviewMode', 'adminPreviewCommerceId', 'masterMode', 'activeOrderFilter',
    `
    const ORDERS_STORAGE_KEY = 'apiacasDeliveryOrders';
    ${realFns}
    return { updateAdminOrderStatus, getSavedOrders, getAdminOrders, confirmClientOrderDelivery,
      debug: () => ({ isCommerce: isCommerceSession(), isMaster: isMasterSession(), activeId: getActiveCommerceId(), rawCount: getSavedOrders().length, raw0: getSavedOrders()[0] }) };
    `
  );
  const api = fn(
    localStorageMock, documentMock, {},
    (msg) => calls.status.push(msg),
    () => { calls.renders += 1; },
    (n) => { calls.cancelOpens.push(n); },
    user, profile, commerceId, null, null, false, activeOrderFilter
  );
  return { api, calls, store };
}

const baseOrder = (over = {}) => ({
  commerceId: '1', customerId: 'u1', customerEmail: 'cliente@teste.com',
  numero: 'APC-0001', data: new Date().toISOString(), status: 'Novo', visualizado: false,
  total: 30, ...over
});

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('PASS - ' + name); }
  else { fail += 1; console.log('FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}


// S1: handler de clique (mapeamento verbatim da linha 1822)
const mapFn = new Function('button', clickMapping.replace(/^ {11}/, '') + ' return nextStatus;');
check('S1 mapeamento deliver -> Saiu para entrega', mapFn({ dataset: { orderAction: 'deliver' } }) === 'Saiu para entrega');
check('S1 mapeamento prepare -> Em preparo', mapFn({ dataset: { orderAction: 'prepare' } }) === 'Em preparo');
check('S1 mapeamento cancel -> Cancelado', mapFn({ dataset: { orderAction: 'cancel' } }) === 'Cancelado');

// S2: render das condicoes dos botoes (verbatim 1808-1810, avaliadas como template literal real)
const canEditStatus = true;
const renderFn = new Function('canEditStatus', 'order', 'escapeAdminValue', 'return `' + renderCond + '`;');
const eav = (v) => String(v ?? '');
for (const [status, expectDeliver] of [['Novo', false], ['Em preparo', true], ['Saiu para entrega', false]]) {
  const html = renderFn(canEditStatus, { status, numero: 'APC-0001' }, eav);
  const hasDeliver = html.includes('data-order-action="deliver"');
  check('S2 status "' + status + '" -> botao Entregar pedido ' + (expectDeliver ? 'presente' : 'ausente'), hasDeliver === expectDeliver);
}

// S3: admin clica "Entregar pedido" em pedido 'Em preparo' (formato atual do checkout)
{
  const env = makeEnv({ orders: [baseOrder({ status: 'Em preparo' })] });
  console.log('DEBUG S3:', JSON.stringify(env.api.debug(), null, 1));
  console.log('DEBUG S3 adminOrders:', JSON.stringify(env.api.getAdminOrders()));
  env.api.updateAdminOrderStatus('APC-0001', 'Saiu para entrega');
  const saved = JSON.parse(env.store.get('apiacasDeliveryOrders'))[0];
  check('S3 pedido vai a "Saiu para entrega" e persiste', saved.status === 'Saiu para entrega', 'status=' + saved.status);
  check('S3 renderAdminOrders reexecuta', env.calls.renders === 1);
}

// S4: pedido LEGADO sem campo status (render mostra "Novo", clique em Preparar)
{
  const legacy = { ...baseOrder() }; delete legacy.status;
  const env = makeEnv({ orders: [legacy] });
  const view = env.api.getAdminOrders()[0];
  check('S4 render normaliza status ausente para "Novo"', view.status === 'Novo');
  env.api.updateAdminOrderStatus('APC-0001', 'Em preparo');
  const saved = JSON.parse(env.store.get('apiacasDeliveryOrders'))[0];
  check('S4 clique em Preparar em pedido legado aplica "Em preparo"', saved.status === 'Em preparo', 'status=' + JSON.stringify(saved.status));
}

// S5: cliente confirma recebimento quando status = Saiu para entrega
{
  const env = makeEnv({ profile: 'client', user: { id: 'u1', email: 'Cliente@Teste.COM' }, orders: [baseOrder({ status: 'Saiu para entrega' })] });
  env.api.confirmClientOrderDelivery('APC-0001');
  const saved = JSON.parse(env.store.get('apiacasDeliveryOrders'))[0];
  check('S5 cliente confirma -> Entregue', saved.status === 'Entregue', 'status=' + saved.status);
}

// S6: cliente NAO confirma se status nao e "Saiu para entrega"
{
  const env = makeEnv({ profile: 'client', orders: [baseOrder({ status: 'Em preparo' })] });
  env.api.confirmClientOrderDelivery('APC-0001');
  const saved = JSON.parse(env.store.get('apiacasDeliveryOrders'))[0];
  check('S6 "Em preparo" nao pode ser confirmado pelo cliente', saved.status === 'Em preparo');
}

// S7: cancelamento abre confirmacao (nao aplica direto)
{
  const env = makeEnv({ orders: [baseOrder({ status: 'Em preparo' })] });
  env.api.updateAdminOrderStatus('APC-0001', 'Cancelado');
  const saved = JSON.parse(env.store.get('apiacasDeliveryOrders'))[0];
  check('S7 cancelamento abre modal em vez de aplicar', saved.status === 'Em preparo' && env.calls.cancelOpens[0] === 'APC-0001');
}

console.log('\nRESULTADO: ' + pass + ' passaram, ' + fail + ' falharam');
process.exit(fail > 0 ? 1 : 0);
