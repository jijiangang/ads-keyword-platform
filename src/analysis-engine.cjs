/**
 * 关键词AI分析引擎 v3 — 8维联合判断矩阵
 *
 * 核心：不再串行堆叠模块，而将曝光/点击/搜索量/ACOS/竞价/市场CPC/
 * 竞争度/竞品广告 8个维度拉入同个矩阵，按组合匹配场景。
 *
 * 矩阵结构：
 *   [A区] 点击=0     → 无数据，仅做曝光+市场诊断（7子场景）
 *   [B区] 点击1~19  → 弱信号，结论仅供参考（5子场景）
 *   [C区] 点击≥20   → 数据可靠，按ACOS分组（C1~C4，共14子场景）
 *
 * 输入: analyze(ss, report30, report60, opts)
 * 输出: { analysis: string[], suggestions: string[], summary: string,
 *         score: number, scoreLabel: string }
 */

const OUR_BRANDS = ['vsitoo', 'vesitoo'];
const KNOWN_BRANDS = ['ember','nextmug','nextboom','leho','cosori','chefman',
  'sodastream','instant pot','nutribullet','ninja','philips','breville',
  "de'longhi",'keurig','nespresso','mr. coffee','hydro flask','stanley',
  'yet','thermos','contigo','ziel','britta'];

// ================================================================
//  维度标准化
// ================================================================
function normalizeDimensions(ss, r30, r60, opts) {
  const { current_bid = 0, daily_budget = null } = opts || {};
  const hasSs = ss && ss.search_vol !== '—' && ss.search_vol !== undefined && ss.search_vol !== null;

  // --- 卖家精灵维度 ---
  const sv         = hasSs ? Number(ss.search_vol) || 0 : null;
  const mktCpc     = hasSs && ss.market_cpc !== '—' && ss.market_cpc !== undefined ? Number(ss.market_cpc) : null;
  const bidMin     = hasSs && ss.bid_min !== '—' && ss.bid_min !== undefined ? Number(ss.bid_min) : null;
  const bidMax     = hasSs && ss.bid_max !== '—' && ss.bid_max !== undefined ? Number(ss.bid_max) : null;
  const suggested  = mktCpc ? Math.ceil(mktCpc / 1.25 * 20) / 20 : null;
  const products   = hasSs ? (Number(ss.products) || 0) : 0;
  const sdr        = hasSs && ss.supply_demand_ratio !== '—' ? Number(ss.supply_demand_ratio) : null;
  const araClick   = hasSs && ss.ara_click_rate !== undefined && ss.ara_click_rate !== null && ss.ara_click_rate !== '—'
    ? Number(ss.ara_click_rate) : null;
  const araShare   = hasSs && ss.ara_share_rate !== '—' ? Number(ss.ara_share_rate) : null;
  const growth     = hasSs && ss.growth != null ? Number(ss.growth) : null;
  const searchPurchases = hasSs ? (ss.search_purchases || 0) : 0;
  const searchClicks    = hasSs ? (ss.search_clicks || 0) : 0;
  const searchConvRate  = searchClicks > 0 ? (searchPurchases / searchClicks * 100) : null;

  // --- 领星报告维度 ---
  const imp  = r30.impressions || 0;
  const clk  = r30.clicks || 0;
  const cost = r30.cost || 0;
  const sales = r30.sales || 0;
  const acos  = sales > 0 ? (cost / sales * 100) : (clk > 0 ? 999 : null);
  const ctr   = imp > 0 ? (clk / imp * 100) : 0;
  const cpc   = clk > 0 ? (cost / clk) : 0;

  // --- 分类维度 (用于场景匹配) ---
  const svCat  = sv === null ? 'none' : (sv >= 3000 ? 'high' : (sv >= 1000 ? 'mid' : 'low'));
  const clkCat = clk >= 20 ? 'high' : (clk >= 5 ? 'low' : (clk >= 1 ? 'tiny' : 'zero'));
  const impCat = imp >= 500 ? 'high' : (imp >= 1 ? 'low' : 'zero');

  let acosCat = 'none';
  if (clk >= 20 && acos !== null) {
    if (acos < 20) acosCat = 'low';
    else if (acos <= 50) acosCat = 'mid';
    else acosCat = 'high';
  } else if (clk >= 5 && acos !== null) {
    acosCat = acos < 30 ? 'low' : (acos <= 50 ? 'mid' : 'high');
  } else if (clk >= 1 && acos !== null) {
    acosCat = 'unreliable';
  } else {
    acosCat = 'nodata';
  }

  // bidCat: compare current_bid vs market_cpc
  let bidCat = 'unknown';
  if (current_bid > 0 && mktCpc) {
    const ratio = current_bid / mktCpc;
    if (ratio < 0.8) bidCat = 'low';
    else if (ratio <= 1.2) bidCat = 'match';
    else bidCat = 'high';
  } else if (current_bid > 0) {
    bidCat = 'noref';
  }

  // compCat
  let compCat = 'unknown';
  if (hasSs) {
    if (products > 10000) compCat = 'fierce';
    else if (products > 3000) compCat = 'moderate';
    else compCat = 'mild';
  }

  // advCat
  let advCat = 'unknown';
  if (araClick !== null) {
    if (araClick > 0.35) advCat = 'high';
    else if (araClick < 0.15) advCat = 'low';
    else advCat = 'mid';
  }

  // --- 预算维度 ---
  const dailyCost30 = cost / 30;
  let bgtCat = 'unknown';
  if (daily_budget > 0) {
    const usage = dailyCost30 / daily_budget;
    if (usage >= 0.8) bgtCat = 'tight';
    else if (usage <= 0.3) bgtCat = 'loose';
    else bgtCat = 'normal';
  }

  return {
    // raw values
    sv, mktCpc, bidMin, bidMax, suggested, current_bid,
    imp, clk, cost, sales, acos, ctr, cpc,
    products, sdr, araClick, araShare, growth,
    searchPurchases, searchClicks, searchConvRate,
    daily_budget, dailyCost30,
    // categorical
    svCat, clkCat, impCat, acosCat, bidCat, compCat, advCat, bgtCat,
    // booleans
    hasSs, isZeroClicks: clk === 0,
    isBudgetConstrained: bgtCat === 'tight',
    isUnderBudget: bgtCat === 'loose',
  };
}

// ================================================================
//  场景匹配
// ================================================================

/**
 * 返回 { id, group, diagnosis, advice, scoreDelta }
 * 优先级：先匹配最具体的场景，再fallback到通用场景
 */
function matchScenario(dim) {
  const { clkCat, impCat, svCat, acosCat, bidCat, compCat, advCat, bgtCat,
          clk, imp, sv, acos, ctr, cost, daily_budget, isBudgetConstrained,
          current_bid, mktCpc, suggested, hasSs, isZeroClicks } = dim;

  // ========== [A区] 点击=0 ==========
  if (clkCat === 'zero') {
    // A1: 零展示 + 高搜索 + 低竞价
    if (impCat === 'zero' && svCat === 'high' && bidCat === 'low') {
      return { id: 'A1', group: 'A',
        diagnosis: '市场搜索量高（' + (sv || '—').toLocaleString() + '），但零曝光。当前竞价 $' + current_bid.toFixed(2) + ' 远低于市场CPC $' + (mktCpc || '—').toFixed(2) + '，出价过低无法赢得广告展示位置。',
        advice: '激进提价至 $' + (suggested || mktCpc || 0).toFixed(2) + ' ~ $' + (mktCpc ? Math.ceil(mktCpc / 1.15 * 20) / 20 : 0).toFixed(2) + '，突破曝光门槛后再优化。当前竞价下再低的竞价也无意义。',
        scoreDelta: -5, bidAction: 'raise_aggressive' };
    }
    // A2: 零展示 + 高搜索 + 竞价合理
    if (impCat === 'zero' && svCat === 'high' && (bidCat === 'match' || bidCat === 'high')) {
      return { id: 'A2', group: 'A',
        diagnosis: '竞价已' + (bidCat === 'high' ? '高于' : '接近') + '市场CPC但仍零曝光，不是竞价问题。',
        advice: '检查投放状态是否"已暂停"、否定关键词是否误伤、匹配方式是否过窄、广告活动预算是否花完。',
        scoreDelta: -3, bidAction: 'none' };
    }
    // A3: 零展示 + 中搜索
    if (impCat === 'zero' && svCat === 'mid') {
      return { id: 'A3', group: 'A',
        diagnosis: '月搜索量 ' + sv.toLocaleString() + '（中等偏低）但零曝光，可能是竞价不足或竞争激烈。',
        advice: '建议按 $' + (suggested || 0.5).toFixed(2) + ' 尝试投放，观察7天初曝光情况决定去留。',
        scoreDelta: -5, bidAction: 'raise_test' };
    }
    // A4: 零展示 + 低搜索
    if (impCat === 'zero' && svCat === 'low') {
      return { id: 'A4', group: 'A',
        diagnosis: '月搜索量仅 ' + sv.toLocaleString() + '，市场需求不足，展示机会极其有限。',
        advice: '建议关停，预算转向搜索量更高的关键词。',
        scoreDelta: -15, bidAction: 'kill' };
    }
    // A5: 有微量展示 + 低竞价
    if (impCat === 'low' && bidCat === 'low') {
      return { id: 'A5', group: 'A',
        diagnosis: '有' + imp + '次展示但竞价低于市场CPC，广告位差导致无人点击。',
        advice: '提价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 改善广告展示位置，获取初始点击数据。',
        scoreDelta: -5, bidAction: 'raise_moderate' };
    }
    // A6: 有微量展示 + 竞价合理但无人点
    if (impCat === 'low' && (bidCat === 'match' || bidCat === 'high' || bidCat === 'noref')) {
      return { id: 'A6', group: 'A',
        diagnosis: '展示少且竞价合理但无人点击，主图/标题缺乏吸引力，非竞价问题。',
        advice: '优化主图和标题提升点击率，调整竞价无效。检查搜索词报告排除无效展示。',
        scoreDelta: -5, bidAction: 'none' };
    }
    // A7: 高展示 + 零点击
    if (impCat === 'high') {
      return { id: 'A7', group: 'A',
        diagnosis: '展示 ' + imp + ' 次但零点击（CTR 0%），点击率严重异常。',
        advice: '检查匹配方式是否过于宽泛带来的无效展示、否定关键词是否误伤、搜索词报告中展示来源是否相关。这不是竞价问题。',
        scoreDelta: -8, bidAction: 'none' };
    }
    // A-fallback: 无卖家精灵数据
    return { id: 'A0', group: 'A',
      diagnosis: '该关键词无广告点击数据且无市场数据，无法评估投放价值。',
      advice: '建议先小额投放测试7天，或直接关停转向已知有效词。',
      scoreDelta: -10, bidAction: 'none' };
  }

  // ========== [B区] 点击1~19(弱信号) ==========
  if (clkCat === 'tiny' || clkCat === 'low') {
    // B1: 点击<5
    if (clk < 5) {
      if (impCat === 'high' && ctr < 0.3) {
        return { id: 'B4', group: 'B',
          diagnosis: '展示 ' + imp + ' 次但仅 ' + clk + ' 次点击（CTR ' + ctr.toFixed(2) + '%），点击率异常偏低。',
          advice: 'CTR仅' + ctr.toFixed(1) + '%，高曝光低点击说明主图/标题缺乏吸引力。不建议调整竞价，优化创意是根本。',
          scoreDelta: -3, bidAction: 'none' };
      }
      if (impCat === 'low' && bidCat === 'low') {
        return { id: 'A5', group: 'A',
          diagnosis: '展示仅 ' + imp + ' 次、点击仅 ' + clk + ' 次，数据太少且竞价低于市场CPC。',
          advice: '提价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 改善广告位获取更多数据。当前数据不足以评估。',
          scoreDelta: -5, bidAction: 'raise_moderate' };
      }
      return { id: 'B1', group: 'B',
        diagnosis: '仅 ' + clk + ' 次点击，样本量不足以做出有效判断，所有指标（含ACOS）仅供参考。' +
          (isBudgetConstrained ? ' 且预算使用率达' + (cost / 30 / (daily_budget || 1) * 100).toFixed(0) + '%，预算可能限制了数据量。' : ''),
        advice: isBudgetConstrained
          ? '先放宽日预算收集更多数据再评估，当前ACOS数字无统计意义。'
          : '继续投放积累数据，待点击达到20+后再重新分析效果。',
        scoreDelta: 0, bidAction: 'wait' };
    }

    // B2: 点击5~19 + ACOS中 + 曝光低 + 竞价低
    if (acosCat === 'mid' && impCat === 'low' && bidCat === 'low') {
      return { id: 'B2', group: 'B',
        diagnosis: 'ACOS ' + (acos !== null ? acos.toFixed(1) : '—') + '% 偏高但数据有限（' + clk + '点击），当前竞价低于市场CPC，出价可能限制了广告位质量。',
        advice: '建议提价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 收集更多数据。弱推荐，最终需20+点击后再确认。',
        scoreDelta: -2, bidAction: 'raise_test' };
    }
    // B3: 点击5~19 + ACOS低 + 竞争缓和
    if (acosCat === 'low' && (compCat === 'mild' || compCat === 'moderate')) {
      return { id: 'B3', group: 'B',
        diagnosis: '初步盈利（ACOS' + (acos !== null ? acos.toFixed(1) : '—') + '%）且竞争' + (compCat === 'mild' ? '缓和' : '中等') + '，数据量有限但方向正确。',
        advice: '维持当前策略，积累更多点击数据后再重新评估。',
        scoreDelta: 0, bidAction: 'hold' };
    }
    // B4: 点击5~19 + 高曝光 + CTR低
    if (impCat === 'high' && ctr < 0.3) {
      return { id: 'B4', group: 'B',
        diagnosis: '展示 ' + imp + ' 次但 CTR 仅 ' + ctr.toFixed(2) + '%，高曝光低点击率，问题在创意。',
        advice: 'CTR明显偏低，建议优化主图/标题。调竞价无法解决CTR问题。',
        scoreDelta: -3, bidAction: 'none' };
    }
    // B5: 点击5~19 + 预算吃紧
    if (isBudgetConstrained) {
      return { id: 'B5', group: 'B',
        diagnosis: '数据有限（' + clk + '点击）且预算紧张（使用率' + (cost / 30 / (daily_budget || 1) * 100).toFixed(0) + '%），两个问题叠加导致ACOS无法可靠评估。',
        advice: '建议先放宽日预算至 $' + Math.ceil((daily_budget || 10) * 1.5) + '~$' + Math.ceil((daily_budget || 10) * 2) + ' 后再评估关键词表现。',
        scoreDelta: -5, bidAction: 'wait' };
    }
    // B-fallback
    return { id: 'B0', group: 'B',
      diagnosis: '点击 ' + clk + ' 次，数据量有限，结论仅供参考。ACOS ' + (acos !== null ? acos.toFixed(1) + '%' : '—') + '。',
      advice: '继续投放积累20+点击后重新分析。',
      scoreDelta: 0, bidAction: 'hold' };
  }

  // ========== [C区] 点击≥20(数据可靠) ==========
  // C4组：低搜索量优先匹配
  if (svCat === 'low' && hasSs) {
    if (compCat === 'mild' && (acosCat === 'low' || acosCat === 'mid')) {
      return { id: 'C4a', group: 'C',
        diagnosis: '搜索量低（' + sv.toLocaleString() + '/月）但竞争缓和且' + (acosCat === 'low' ? '盈利' : 'ACOS可控') + '，属于精准长尾词。',
        advice: '维持低竞价精准匹配，无需主动关闭。长尾词精准但体量有限。',
        scoreDelta: 5, bidAction: 'hold' };
    }
    if (acosCat === 'high') {
      return { id: 'C4b', group: 'C',
        diagnosis: '搜索量仅 ' + sv.toLocaleString() + '/月 且 ACOS ' + acos.toFixed(1) + '% 过高。搜索基数太小，不值得继续投入。',
        advice: '建议关停，将预算转向中高搜索量的关键词。',
        scoreDelta: -8, bidAction: 'kill' };
    }
    if ((advCat === 'low' || advCat === 'unknown') && (acosCat === 'mid')) {
      return { id: 'C4c', group: 'C',
        diagnosis: '搜索量低+' + (advCat === 'low' ? '竞品广告投入也低' : '') + '+' + 'ACOS ' + acos.toFixed(1) + '%，竞品不投入的情况下仍不理想，产品端竞争力不足。',
        advice: '建议关停或仅维持极低出价。',
        scoreDelta: -10, bidAction: 'kill_or_low' };
    }
  }

  // C1组: ACOS低(<20%)
  if (acosCat === 'low') {
    // C1a: 盈利 + 市场有空间
    if (impCat === 'high' && sv !== null && sv > imp * 10 && (compCat === 'mild' || compCat === 'moderate')) {
      return { id: 'C1a', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 盈利，月搜索量 ' + sv.toLocaleString() + ' 远大于当前曝光，市场潜力充足，竞争' + (compCat === 'mild' ? '缓和' : '中等') + '。',
        advice: '建议提价扩量（目标价 $' + (Math.ceil(current_bid * 1.15 * 20) / 20).toFixed(2) + '），充分释放市场潜力。',
        scoreDelta: 15, bidAction: 'raise_expand' };
    }
    // C1c: 红海低ACOS → 产品力强（优先于C1b，更具体）
    if (compCat === 'fierce' && (advCat === 'high' || advCat === 'mid')) {
      return { id: 'C1c', group: 'C',
        diagnosis: '在激烈竞争（产品' + dim.products.toLocaleString() + '个、广告点击份额' + (dim.araShare !== null ? (dim.araShare * 100).toFixed(1) + '%' : '—') + '）中保持 ACOS ' + acos.toFixed(1) + '%，产品转化力强。',
        advice: '维持优势地位，适度防御性出价，防止竞品抢占份额。',
        scoreDelta: 15, bidAction: 'hold' };
    }
    // C1b: 盈利 + 市场触顶
    if (impCat !== 'low' && sv !== null && sv <= imp * 10) {
      return { id: 'C1b', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 盈利稳定，当前曝光量已覆盖大部分搜索需求，市场空间有限。',
        advice: '维持当前策略，关注竞品动态以防被抢位。',
        scoreDelta: 10, bidAction: 'hold' };
    }
    // C1-fallback
    return { id: 'C1x', group: 'C',
      diagnosis: 'ACOS ' + acos.toFixed(1) + '% 表现健康（' + clk + '次点击），当前策略可行。',
      advice: '保持现状，持续关注ACOS变化趋势。',
      scoreDelta: 10, bidAction: 'hold' };
  }

  // C2组: ACOS中(20~50%)
  if (acosCat === 'mid') {
    // C2a: 竞价低 + 曝光低
    if (bidCat === 'low' && impCat === 'low') {
      return { id: 'C2a', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 偏高，同时曝光不足且竞价低于市场CPC。ACOS偏高可能与低竞价→广告位差有关。',
        advice: '建议提价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 改善广告位，观察ACOS是否随数据质量提升而改善。',
        scoreDelta: 0, bidAction: 'raise_moderate' };
    }
    // C2c: 竞价高于市场
    if (bidCat === 'high') {
      return { id: 'C2c', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 偏高且当前竞价 $' + current_bid.toFixed(2) + ' 高于市场CPC $' + (mktCpc || 0).toFixed(2) + '，出价偏高推高了广告成本。',
        advice: '建议下调竞价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 控制成本。',
        scoreDelta: -3, bidAction: 'lower' };
    }
    // C2d: CTR异常
    if (impCat === 'high' && ctr < 0.3) {
      return { id: 'C2d', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 偏高源于 CTR 仅 ' + ctr.toFixed(2) + '%——高曝光但点击不足，导致转化基数小、ACOS虚高。',
        advice: '优化主图/标题提升点击率，调整竞价无效。',
        scoreDelta: -3, bidAction: 'none' };
    }
    // C2b: 竞价合理 + 正常曝光
    return { id: 'C2b', group: 'C',
      diagnosis: 'ACOS ' + acos.toFixed(1) + '% 偏高但竞价合理（$' + current_bid.toFixed(2) + '）、曝光正常（' + imp.toLocaleString() + '），问题可能在转化端。',
      advice: '检查Listing转化率、竞品动态、售价竞争力。关注优化详情页和图片。',
      scoreDelta: 0, bidAction: 'hold' };
  }

  // C3组: ACOS高(≥50%)
  if (acosCat === 'high') {
    // C3e: 严重亏损 + 有数据
    if (acos !== null && acos > 100 && clk > 30) {
      return { id: 'C3e', group: 'C',
        diagnosis: '🚨 ACOS ' + acos.toFixed(1) + '% 严重亏损且点击 ' + clk + ' 次数据充足，该词持续烧钱产出极低。',
        advice: '建议立即暂停该关键词，检查产品售价、评分、竞品对比是否不具备竞争力。',
        scoreDelta: -15, bidAction: 'kill' };
    }
    // C3a: 恶性循环（低竞价+低曝光+数据有限）
    if (bidCat === 'low' && impCat !== 'high' && clk < 50) {
      return { id: 'C3a', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 高但竞价 $' + current_bid.toFixed(2) + ' < 市场CPC $' + (mktCpc || 0).toFixed(2) + '，曝光 ' + imp + ' 次、点击 ' + clk + ' 次——典型的"低竞价→差广告位→低质高价点击→高ACOS"恶性循环。',
        advice: '先提价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 改善广告位质量，获取足够曝光后再评估ACOS。盲目降价只会让恶性循环加剧。',
        scoreDelta: -2, bidAction: 'raise_moderate' };
    }
    // C3b: 竞价低但有相当数据量
    if (bidCat === 'low' && impCat === 'high' && clk >= 50) {
      return { id: 'C3b', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 高且有 ' + clk + ' 次点击数据，竞价 $' + current_bid.toFixed(2) + ' 低于市场CPC $' + (mktCpc || 0).toFixed(2) + '。数据量说明出价低也能获取展示但转化率可能不足。',
        advice: '适度提价至 $' + (suggested || (mktCpc || 0)).toFixed(2) + ' 测试广告位改善效果，同时检查Product Listing转化端。',
        scoreDelta: -5, bidAction: 'raise_test' };
    }
    // C3d: 竞价合理 + 高曝光 + 低点击（CTR问题）
    if (impCat === 'high' && ctr < 0.3) {
      return { id: 'C3d', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 高但根因是 CTR 仅 ' + ctr.toFixed(2) + '%——展示 ' + imp + ' 次但点击不足，转化基数小，ACOS被动抬高。',
        advice: '优化主图/标题提升点击率，调竞价无法解决。',
        scoreDelta: -5, bidAction: 'none' };
    }
    // C3f: 预算吃紧
    if (isBudgetConstrained && clk < 30) {
      return { id: 'C3f', group: 'C',
        diagnosis: 'ACOS ' + acos.toFixed(1) + '% 高但预算吃紧（使用率' + (cost / 30 / (daily_budget || 1) * 100).toFixed(0) + '%）且点击仅 ' + clk + ' 次，数据可能失真。预算限制导致无法获得足够优质曝光。',
        advice: '先放宽日预算至 $' + Math.ceil((daily_budget || 10) * 1.5) + '~$' + Math.ceil((daily_budget || 10) * 2) + '，获取充分数据后再判定ACOS是否真实偏高。',
        scoreDelta: 0, bidAction: 'wait' };
    }
    // C3c: 真正高ACOS（竞价合理+数据充足）
    return { id: 'C3c', group: 'C',
      diagnosis: '🚨 ACOS ' + acos.toFixed(1) + '% 过高且竞价合理（$' + current_bid.toFixed(2) + '），曝光 ' + imp.toLocaleString() + ' 次、点击 ' + clk + ' 次数据充足——这是真正的ACOS问题。',
      advice: '建议大幅降低竞价（目标 $' + (Math.ceil(current_bid * 0.7 * 20) / 20).toFixed(2) + '）或暂停。同时调查产品转化率、竞品售价、Listing质量是否具备竞争力。',
      scoreDelta: -10, bidAction: 'lower_or_kill' };
  }

  // fallback（极少到达这里）
  return { id: 'C0', group: 'C',
    diagnosis: '点击 ' + clk + ' 次，ACOS ' + (acos !== null ? acos.toFixed(1) + '%' : '—') + '。',
    advice: hasSs && sv !== null && sv >= 1000 ? '该词有市场潜力，持续关注表现。' : '维持当前策略。',
    scoreDelta: 0, bidAction: 'hold' };
}

// ================================================================
//  品牌分析（保持v2逻辑）
// ================================================================
function brandAnalysis(kwLower, ssBrands) {
  const lines = [], sugs = [];
  const ssBrandsLower = (ssBrands || []).map(b => b.toLowerCase());
  const isOurBrand = OUR_BRANDS.some(b => kwLower.includes(b)) ||
    ssBrandsLower.some(b => OUR_BRANDS.includes(b));
  const hasComp = KNOWN_BRANDS.some(b => kwLower.includes(b));
  const compList = (ssBrands || []).filter(b =>
    !OUR_BRANDS.includes(b.toLowerCase()) && KNOWN_BRANDS.includes(b.toLowerCase()));

  if (isOurBrand) {
    lines.push('🏷️ **品牌词**：VSITOO 品牌出现在该词搜索中。');
    sugs.push('品牌词建议低竞价保底（市场CPC×30%~50%），精准匹配即可，品牌自然搜索已有排名优势。');
  } else if (hasComp) {
    lines.push('🏷️ **竞品品牌词**：含竞品品牌关键词，搜索意图是品牌导向。');
    sugs.push('竞品品牌词需警惕无效点击，建议仅精准匹配，维持中等出价关注转化。');
  } else if (ssBrands && ssBrands.length > 0) {
    lines.push('🏷️ **搜索结果品牌分布**：主要品牌 ' + ssBrands.slice(0, 5).join('、') + '。');
    if (ssBrandsLower.some(b => OUR_BRANDS.includes(b)))
      lines.push('✅ VSITOO 已在该词搜索中占据一席之地。');
    else
      sugs.push('VSITOO 不在该词搜索品牌前列，考虑通过品牌广告提升曝光。');
  } else {
    lines.push('🏷️ **非品牌词**：通用搜索词，按常规策略操作。');
  }
  return { lines, sugs };
}

// ================================================================
//  趋势与竞争分析
// ================================================================
function volumeAnalysis(dim) {
  const lines = [], sugs = [];
  const { hasSs, sv, svCat, growth, compCat, products, sdr, araClick, araShare,
          clk, imp, cost, sales, acos, ctr, cpc } = dim;

  if (!hasSs) return { lines, sugs };

  // 搜索热度
  const volLabels = { none: '', high: '🔥 高流量', mid: '📊 中等流量', low: '💧 长尾词' };
  lines.push('📈 **搜索热度**：月搜索量 ' + (sv || 0).toLocaleString() + '（' + (volLabels[svCat] || '—') + '）' +
    (dim.products > 0 ? '，产品数 ' + dim.products.toLocaleString() : ''));

  // 趋势
  if (growth !== null) {
    const dir = growth > 0 ? '📈 上升' : (growth < 0 ? '📉 下降' : '➡️ 持平');
    lines.push('📊 **月环比**：' + dir + ' ' + Math.abs(growth).toFixed(1) + '%');
    if (growth > 20) sugs.push('搜索量快速增长+' + growth.toFixed(1) + '%，建议积极加价抢占位置。');
    else if (growth < -20) sugs.push('搜索量骤降' + Math.abs(growth).toFixed(1) + '%，若ACOS偏高考虑暂停，待下一周期。');
  }

  // 竞争格局
  if (compCat !== 'unknown') {
    const compStr = compCat === 'fierce' ? '🔴 红海' : (compCat === 'moderate' ? '🟡 中等' : '🟢 蓝海');
    const sdrStr = sdr !== null ? '（供需比' + sdr.toFixed(2) + (sdr < 0.5 ? '，供不应求' : sdr > 2 ? '，供过于求' : '，供需平衡') + '）' : '';
    lines.push('⚔️ **竞争格局**：' + compStr + sdrStr);
    if (compCat === 'fierce') sugs.push('高竞争词建议精准匹配控制ACOS，关注长尾变体获取低成本流量。');
    if (compCat === 'mild') sugs.push('蓝海词建议加大投放抢流量。');
  }

  // ARA广告市场
  if (araClick !== null) {
    const crPct = (araClick * 100).toFixed(1);
    lines.push('🔍 **广告市场**：点击率 ' + crPct + '%' +
      (araShare !== null ? '，份额 ' + (araShare * 100).toFixed(1) + '%' : ''));
    if (araClick > 0.35) sugs.push('广告点击率' + crPct + '%较高，用户广告购买意图强，值得加大投入。');
    else if (araClick < 0.1) sugs.push('广告点击率仅' + crPct + '%，用户广告点击意愿偏低，检查广告位质量。');
  }

  // 搜索转化率
  if (dim.searchConvRate !== null && dim.searchConvRate > 0) {
    lines.push('🛒 **搜索转化**：自然转化 ' + dim.searchConvRate.toFixed(1) + '%（' + dim.searchPurchases + '单/' + dim.searchClicks + '点击）');
    if (dim.searchConvRate > 10) sugs.push('自然转化率优秀，购买意图明确，重点投放。');
    else if (dim.searchConvRate < 3) sugs.push('自然转化率偏低，可能是信息型搜索词，适当降低竞价。');
  }

  return { lines, sugs };
}

// ================================================================
//  竞价数值建议
// ================================================================
function bidSuggestion(dim, scenario) {
  const { current_bid, mktCpc, suggested } = dim;
  const action = scenario.bidAction;

  let target = null, detail = '';

  switch (action) {
    case 'raise_aggressive':
      target = Math.max(suggested || 0, Math.ceil((mktCpc || 0) / 1.15 * 20) / 20);
      detail = '激进提价至 $' + target.toFixed(2) + '（市场CPC的115%），零曝光需先突破曝光门槛。';
      break;
    case 'raise_moderate':
      target = suggested || (mktCpc || current_bid);
      detail = '提价至 $' + target.toFixed(2) + '（建议竞价），改善广告位。';
      break;
    case 'raise_test':
      target = suggested || (mktCpc || current_bid);
      detail = '适度提价至 $' + target.toFixed(2) + ' 测试广告位改善效果。';
      break;
    case 'raise_expand':
      target = Math.ceil(current_bid * 1.15 * 20) / 20;
      detail = '提价至 $' + target.toFixed(2) + '（当前×1.15），盈利扩量。';
      break;
    case 'lower':
      target = suggested || (mktCpc || current_bid);
      detail = '下调至 $' + target.toFixed(2) + '（建议竞价），控制成本。';
      break;
    case 'lower_or_kill':
      target = Math.ceil(current_bid * 0.7 * 20) / 20;
      detail = '降至 $' + target.toFixed(2) + ' 或直接暂停。真正高ACOS需要大幅调整。';
      break;
    case 'kill':
      detail = '建议暂停该关键词。';
      break;
    case 'kill_or_low':
      detail = '关停，或维持极低出价 $' + Math.max(0.05, suggested !== null ? suggested * 0.5 : 0.1).toFixed(2);
      break;
    case 'wait':
      detail = '暂不调整竞价，积累更多数据再做决定。';
      break;
    case 'hold':
      detail = '维持当前 $' + current_bid.toFixed(2) + '，暂无调整必要。';
      break;
    case 'none':
    default:
      detail = '该问题与竞价无关，不需要调整。';
      break;
  }

  // 补充竞价范围信息
  let rangeInfo = '';
  if (dim.bidMin !== null && dim.bidMax !== null && mktCpc) {
    rangeInfo = '（市场竞价范围 $' + dim.bidMin.toFixed(2) + '~$' + dim.bidMax.toFixed(2) + '）';
  }

  return { action, target, detail, rangeInfo };
}

// ================================================================
//  主入口
// ================================================================
function analyze(ss, report30, report60, opts = {}) {
  const dim = normalizeDimensions(ss, report30, report60, opts);
  const { current_bid, keyword_text, average_sales_price } = opts;

  // 1. 场景匹配
  const scenario = matchScenario(dim);

  // 2. 品牌分析
  const brandResult = brandAnalysis(
    (keyword_text || '').toLowerCase(),
    (ss && ss.brands) || []
  );

  // 3. 趋势与竞争
  const volResult = volumeAnalysis(dim);

  // 4. 竞价建议
  const bidResult = bidSuggestion(dim, scenario);

  // 5. 数据置信度标签
  let confidenceNote = '';
  if (dim.clk === 0) confidenceNote = '❌ **无数据**：零点击，无法评估广告效果。';
  else if (dim.clk < 5) confidenceNote = '⚠️ **数据不足**：仅 ' + dim.clk + ' 次点击，ACOS等指标不可靠。';
  else if (dim.clk < 20) confidenceNote = '🔸 **弱信号**：' + dim.clk + ' 次点击，结论仅供参考。';
  else confidenceNote = '✅ **数据可靠**：' + dim.clk + ' 次点击，结论可信。';

  // 6. 组装输出
  const analysis = [];

  // 置信度
  analysis.push('📊 **数据置信度**：' + confidenceNote);

  // 品牌
  brandResult.lines.forEach(l => analysis.push(l));

  // 趋势与竞争
  volResult.lines.forEach(l => analysis.push(l));

  // 曝光+点击诊断 + 预算诊断（来自scenario）
  analysis.push('📡 **诊断结论**：' + scenario.diagnosis);

  // 预算补充
  if (dim.isBudgetConstrained) {
    const usage = (dim.dailyCost30 / (dim.daily_budget || 1) * 100).toFixed(0);
    analysis.push('💰 **预算**：日预算 $' + (dim.daily_budget || 0).toFixed(2) +
      '，使用率 ' + usage + '%，预算' + (dim.clk < 20 ? '紧张且数据量可能受限' : '接近上限'));
  } else if (dim.isUnderBudget && dim.isZeroClicks) {
    analysis.push('💰 **预算**：日预算 $' + (dim.daily_budget || 0).toFixed(2) +
      ' 充足但花不出去——问题在竞价不在预算。');
  }

  // 竞价分析
  let bidLine = '💰 **竞价**：当前 $' + current_bid.toFixed(2);
  if (dim.mktCpc) bidLine += ' | 市场CPC $' + dim.mktCpc.toFixed(2);
  if (dim.suggested) bidLine += ' | 建议竞价 $' + dim.suggested.toFixed(2);
  if (bidResult.rangeInfo) bidLine += ' ' + bidResult.rangeInfo;
  bidLine += ' → ' + bidResult.detail;
  analysis.push(bidLine);

  // 广告表现（仅有点击时）
  if (dim.clk > 0) {
    analysis.push('📆 **近30天**：展示 ' + dim.imp.toLocaleString() +
      ' | 点击 ' + dim.clk + ' | CTR ' + dim.ctr.toFixed(1) +
      '% | CPC $' + dim.cpc.toFixed(2) +
      (dim.acos !== null ? ' | ACOS ' + dim.acos.toFixed(1) + '%' : ''));
  }

  // 评分
  const scoreBase = 50;
  let score = Math.max(0, Math.min(100, Math.round(scoreBase + scenario.scoreDelta)));
  const scoreLabels = [
    { min: 85, label: '⭐ 强烈推荐' },
    { min: 70, label: '✅ 优先投放' },
    { min: 50, label: '➡️ 正常维护' },
    { min: 35, label: '⚠️ 谨慎投入' },
    { min: 0, label: '🔴 建议暂停' }
  ];
  const scoreLabel = scoreLabels.find(s => score >= s.min)?.label || '🔴 建议暂停';

  analysis.push('\n📊 **综合评分**：' + score + '/100 — ' + scoreLabel);

  // 建议
  const allSugs = [...brandResult.sugs, ...volResult.sugs, scenario.advice];
  const uniqueSugs = [...new Set(allSugs.filter(Boolean))].slice(0, 5);
  const summary = uniqueSugs.length > 0
    ? uniqueSugs.map((s, i) => (i + 1) + '. ' + s).join('\n')
    : '✅ 该关键词表现正常，无紧急优化建议。';

  return { analysis, suggestions: uniqueSugs, summary, score, scoreLabel };
}

module.exports = { analyze };
