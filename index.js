// ==UserScript==
// @name         Auto Read (Stealth)
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  自动刷linuxdo文章（隐蔽模式）
// @author       liuweiqing
// @match        https://meta.discourse.org/*
// @match        https://linux.do/*
// @match        https://meta.appinn.net/*
// @match        https://community.openai.com/*
// @match        https://idcflare.com/*
// @exclude      https://linux.do/a/9611/0
// @grant        none
// @license      MIT
// @icon         https://www.google.com/s2/favicons?domain=linux.do
// @downloadURL https://update.greasyfork.org/scripts/489464/Auto%20Read.user.js
// @updateURL https://update.greasyfork.org/scripts/489464/Auto%20Read.meta.js
// ==/UserScript==

(function () {
  "use strict";

  // ============= 配置项 =============
  const CONFIG = {
    // 每日配额（通过 localStorage 可被 bypasscf.js 覆盖）
    dailyTopicLimit: parseInt(localStorage.getItem("stealthDailyTopicLimit") || "8", 10),
    dailyLikeLimit: parseInt(localStorage.getItem("stealthDailyLikeLimit") || "1", 10),

    // 阅读时间范围（毫秒）
    minReadTime: parseInt(localStorage.getItem("stealthMinReadTime") || "30000", 10),   // 30秒
    maxReadTime: parseInt(localStorage.getItem("stealthMaxReadTime") || "240000", 10),  // 4分钟

    // 滚动参数
    scrollSpeedMin: 12,      // 最慢 px/step
    scrollSpeedMax: 45,      // 最快 px/step
    scrollIntervalMin: 30,   // 最快间隔 ms
    scrollIntervalMax: 130,  // 最慢间隔 ms

    // 阅读暂停
    pauseChancePerCheck: 0.03,   // 每次滚动检查时 3% 概率暂停
    pauseDurationMin: 1500,      // 暂停 1.5~6 秒
    pauseDurationMax: 6000,
    backScrollChance: 0.02,      // 2% 概率向上回翻
    backScrollMin: 50,
    backScrollMax: 200,

    // 点赞概率
    likeChance: 0.08,  // 8% 概率
    likeMinScrollRatio: 0.5,  // 至少滚动 50% 才考虑点赞

    // 话题间等待
    topicGapMin: 3000,   // 3~10 秒
    topicGapMax: 10000,

    // 话题列表每次只取 1 页
    topicListPageSize: 30,
  };

  // ============= 基础 URL 检测 =============
  const possibleBaseURLs = [
    "https://linux.do",
    "https://meta.discourse.org",
    "https://meta.appinn.net",
    "https://community.openai.com",
    "https://idcflare.com",
  ];

  const currentURL = window.location.href;
  let BASE_URL = possibleBaseURLs.find((url) => currentURL.startsWith(url));
  if (!BASE_URL) {
    BASE_URL = possibleBaseURLs[0];
  }

  // ============= 工具函数 =============

  // 高斯随机数（Box-Muller），让行为更自然
  function gaussianRandom(mean, stdDev) {
    let u1 = Math.random();
    let u2 = Math.random();
    let z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return Math.max(0, mean + z * stdDev);
  }

  // 范围内随机整数
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 范围内随机浮点
  function randFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  // 异步延迟
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 获取今天的日期 key (YYYY-MM-DD)
  function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  // ============= 每日配额管理 =============

  function getDailyStats() {
    const dateKey = localStorage.getItem("stealth_dateKey");
    const today = getTodayKey();

    if (dateKey !== today) {
      // 新的一天，重置计数
      localStorage.setItem("stealth_dateKey", today);
      localStorage.setItem("stealth_topicsToday", "0");
      localStorage.setItem("stealth_likesToday", "0");
      return { topicsToday: 0, likesToday: 0 };
    }

    return {
      topicsToday: parseInt(localStorage.getItem("stealth_topicsToday") || "0", 10),
      likesToday: parseInt(localStorage.getItem("stealth_likesToday") || "0", 10),
    };
  }

  function incrementTopicCount() {
    const stats = getDailyStats();
    const newCount = stats.topicsToday + 1;
    localStorage.setItem("stealth_topicsToday", String(newCount));
    console.log(`[stealth] 今日已阅读话题: ${newCount}/${CONFIG.dailyTopicLimit}`);
    return newCount;
  }

  function incrementLikeCount() {
    const stats = getDailyStats();
    const newCount = stats.likesToday + 1;
    localStorage.setItem("stealth_likesToday", String(newCount));
    console.log(`[stealth] 今日已点赞: ${newCount}/${CONFIG.dailyLikeLimit}`);
    return newCount;
  }

  function hasReachedTopicLimit() {
    const stats = getDailyStats();
    return stats.topicsToday >= CONFIG.dailyTopicLimit;
  }

  function hasReachedLikeLimit() {
    const stats = getDailyStats();
    return stats.likesToday >= CONFIG.dailyLikeLimit;
  }

  // ============= 人类模拟滚动 =============

  let scrollTimer = null;
  let readingTimer = null;
  let isPaused = false;
  let totalPageHeight = 0;
  let scrollStartY = 0;

  function getScrollProgress() {
    const scrolled = window.scrollY - scrollStartY;
    const scrollable = document.body.scrollHeight - window.innerHeight;
    return scrollable > 0 ? scrolled / scrollable : 1;
  }

  function isNearBottom() {
    return window.innerHeight + window.scrollY >= document.body.offsetHeight - 150;
  }

  function startHumanScroll() {
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer);
    }
    scrollStartY = window.scrollY;
    totalPageHeight = document.body.scrollHeight;
    scheduleNextScroll();
  }

  function scheduleNextScroll() {
    if (localStorage.getItem("read") !== "true") return;

    // 计算随机的间隔和距离（高斯分布让大部分值集中在中间）
    const stepSize = Math.round(gaussianRandom(
      (CONFIG.scrollSpeedMin + CONFIG.scrollSpeedMax) / 2,
      (CONFIG.scrollSpeedMax - CONFIG.scrollSpeedMin) / 4
    ));
    const interval = Math.round(gaussianRandom(
      (CONFIG.scrollIntervalMin + CONFIG.scrollIntervalMax) / 2,
      (CONFIG.scrollIntervalMax - CONFIG.scrollIntervalMin) / 4
    ));

    const clampedStep = Math.max(CONFIG.scrollSpeedMin, Math.min(CONFIG.scrollSpeedMax, stepSize));
    const clampedInterval = Math.max(CONFIG.scrollIntervalMin, Math.min(CONFIG.scrollIntervalMax, interval));

    scrollTimer = setTimeout(() => {
      if (localStorage.getItem("read") !== "true") return;

      // 偶尔暂停（模拟阅读）
      if (!isPaused && Math.random() < CONFIG.pauseChancePerCheck) {
        isPaused = true;
        const pauseDuration = randInt(CONFIG.pauseDurationMin, CONFIG.pauseDurationMax);
        console.log(`[stealth] 阅读暂停 ${(pauseDuration / 1000).toFixed(1)}s`);
        setTimeout(() => {
          isPaused = false;
          scheduleNextScroll();
        }, pauseDuration);
        return;
      }

      // 偶尔向上回翻
      if (Math.random() < CONFIG.backScrollChance) {
        const backAmount = randInt(CONFIG.backScrollMin, CONFIG.backScrollMax);
        window.scrollBy(0, -backAmount);
        console.log(`[stealth] 回翻 ${backAmount}px`);
        scheduleNextScroll();
        return;
      }

      // 正常向下滚动
      window.scrollBy(0, clampedStep);

      // 检查是否到底
      if (isNearBottom()) {
        onReachedBottom();
        return;
      }

      scheduleNextScroll();
    }, clampedInterval);
  }

  function stopScrolling() {
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
    if (readingTimer !== null) {
      clearTimeout(readingTimer);
      readingTimer = null;
    }
  }

  // ============= 到达底部后的处理 =============

  function onReachedBottom() {
    stopScrolling();
    console.log("[stealth] 到达底部");

    // 尝试点赞（在到底之后，概率判断）
    maybeAutoLike();

    // 检查是否达到每日话题上限
    const newCount = incrementTopicCount();
    if (newCount >= CONFIG.dailyTopicLimit) {
      console.log("[stealth] 已达到今日话题上限，停止阅读");
      localStorage.setItem("read", "false");
      return;
    }

    // 等待一段时间后跳转到下一个话题
    const gap = randInt(CONFIG.topicGapMin, CONFIG.topicGapMax);
    console.log(`[stealth] ${(gap / 1000).toFixed(1)}s 后跳转下一个话题`);
    setTimeout(() => {
      navigateToNextTopic();
    }, gap);
  }

  // ============= 话题导航 =============

  async function fetchTopicList() {
    // 随机选一个列表源
    const sources = [
      `${BASE_URL}/latest.json?no_definitions=true&page=0`,
      `${BASE_URL}/latest.json?no_definitions=true&page=1`,
      `${BASE_URL}/top.json?period=weekly`,
    ];
    const sourceUrl = sources[randInt(0, sources.length - 1)];

    try {
      const response = await fetch(sourceUrl, {
        headers: { "Accept": "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data && data.topic_list && data.topic_list.topics) {
        // 过滤掉评论过多的话题（可能是超长讨论帖）
        return data.topic_list.topics.filter(
          (t) => t.posts_count > 2 && t.posts_count < 500
        );
      }
    } catch (err) {
      console.error("[stealth] 获取话题列表失败:", err.message);
    }
    return [];
  }

  async function navigateToNextTopic() {
    if (localStorage.getItem("read") !== "true") return;

    const topics = await fetchTopicList();
    if (topics.length === 0) {
      console.log("[stealth] 未获取到话题，停止");
      localStorage.setItem("read", "false");
      return;
    }

    // 随机选一个话题（不是按顺序）
    const topic = topics[randInt(0, Math.min(topics.length - 1, CONFIG.topicListPageSize - 1))];
    const url = topic.last_read_post_number
      ? `${BASE_URL}/t/topic/${topic.id}/${topic.last_read_post_number}`
      : `${BASE_URL}/t/topic/${topic.id}`;

    console.log(`[stealth] 跳转话题: ${topic.id} (${topic.title?.slice(0, 30)}...)`);
    window.location.href = url;
  }

  // ============= 自动阅读（每个话题的定时器） =============

  function startReadingTopic() {
    // 计算这个话题要读多久
    const readTime = randInt(CONFIG.minReadTime, CONFIG.maxReadTime);
    console.log(`[stealth] 本话题阅读时间: ${(readTime / 1000).toFixed(0)}s`);

    // 开始人类模拟滚动
    startHumanScroll();

    // 设置最大阅读时间，到时间了即使没滚到底也跳走
    readingTimer = setTimeout(() => {
      if (localStorage.getItem("read") === "true") {
        console.log("[stealth] 阅读时间到，跳转下一个话题");
        stopScrolling();
        maybeAutoLike();
        const newCount = incrementTopicCount();
        if (newCount >= CONFIG.dailyTopicLimit) {
          console.log("[stealth] 已达到今日话题上限，停止阅读");
          localStorage.setItem("read", "false");
          return;
        }
        const gap = randInt(CONFIG.topicGapMin, CONFIG.topicGapMax);
        setTimeout(() => navigateToNextTopic(), gap);
      }
    }, readTime);
  }

  // ============= 自动点赞（隐蔽版） =============

  function maybeAutoLike() {
    if (localStorage.getItem("autoLikeEnabled") === "false") return;
    if (hasReachedLikeLimit()) return;

    // 只有滚动超过一定比例才考虑
    const progress = getScrollProgress();
    if (progress < CONFIG.likeMinScrollRatio) return;

    // 概率判定
    if (Math.random() > CONFIG.likeChance) return;

    // 找到能点赞的按钮
    const buttons = document.querySelectorAll(".discourse-reactions-reaction-button");
    if (buttons.length === 0) return;

    // 随机选一个可点赞的按钮（靠近当前可视区域的）
    const viewportCenter = window.scrollY + window.innerHeight / 2;
    const nearbyButtons = Array.from(buttons).filter((btn) => {
      if (btn.title !== "点赞此帖子" && btn.title !== "Like this post") return false;
      const rect = btn.getBoundingClientRect();
      const absY = rect.top + window.scrollY;
      // 只选在当前视口上下 500px 范围内的
      return Math.abs(absY - viewportCenter) < 500;
    });

    if (nearbyButtons.length === 0) return;

    const targetBtn = nearbyButtons[randInt(0, nearbyButtons.length - 1)];

    // 延迟点赞（模拟思考时间）
    const likeDelay = randInt(800, 3000);
    setTimeout(() => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      targetBtn.dispatchEvent(event);
      incrementLikeCount();
      console.log("[stealth] 已点赞");
    }, likeDelay);
  }

  // ============= 初始化 =============

  function checkFirstRun() {
    if (localStorage.getItem("isFirstRun") === null) {
      console.log("[stealth] 首次运行，初始化设置");
      localStorage.setItem("read", "false");
      localStorage.setItem("autoLikeEnabled", "false");
      localStorage.setItem("isFirstRun", "false");
    }
  }

  // ============= 入口 =============

  window.addEventListener("load", () => {
    checkFirstRun();

    const isReading = localStorage.getItem("read") === "true";
    const isAutoLike = localStorage.getItem("autoLikeEnabled") !== "false";

    console.log(`[stealth] read=${isReading}, autoLike=${isAutoLike}`);
    console.log(`[stealth] 配额: 话题 ${CONFIG.dailyTopicLimit}/天, 点赞 ${CONFIG.dailyLikeLimit}/天`);

    const stats = getDailyStats();
    console.log(`[stealth] 今日已完成: 话题 ${stats.topicsToday}, 点赞 ${stats.likesToday}`);

    if (isReading) {
      // 检查是否已达到今日上限
      if (hasReachedTopicLimit()) {
        console.log("[stealth] 今日话题上限已达到，不继续阅读");
        localStorage.setItem("read", "false");
        return;
      }

      // 判断当前页面是话题页还是列表页
      const isTopicPage = /\/t\/[^/]+\/\d+/.test(window.location.pathname);
      if (isTopicPage) {
        // 在话题页 → 开始阅读
        const initialDelay = randInt(1000, 3000);
        setTimeout(() => startReadingTopic(), initialDelay);
      } else {
        // 在列表页 → 随机点一个话题进入
        const initialDelay = randInt(2000, 5000);
        setTimeout(() => {
          // 先随机滚动一下列表页
          const scrollDist = randInt(200, 800);
          window.scrollBy(0, scrollDist);
          setTimeout(() => {
            navigateToNextTopic();
          }, randInt(1000, 3000));
        }, initialDelay);
      }
    }
  });

  // ============= UI 控制按钮 =============

  const button = document.createElement("button");
  button.textContent =
    localStorage.getItem("read") === "true" ? "停止阅读" : "开始阅读";
  button.style.cssText = `
    position: fixed; bottom: 10px; left: 10px; z-index: 1000;
    background-color: #f0f0f0; color: #000; border: 1px solid #ddd;
    padding: 5px 10px; border-radius: 5px; font-size: 12px; cursor: pointer;
  `;
  document.body.appendChild(button);

  button.onclick = function () {
    const currentlyReading = localStorage.getItem("read") === "true";
    const newReadState = !currentlyReading;
    localStorage.setItem("read", newReadState.toString());
    button.textContent = newReadState ? "停止阅读" : "开始阅读";

    if (!newReadState) {
      stopScrolling();
    } else {
      // 开始阅读：跳转到最新页面
      window.location.href = `${BASE_URL}/latest`;
    }
  };

  // 自动点赞按钮
  const toggleAutoLikeButton = document.createElement("button");
  const isAutoLikeOn = localStorage.getItem("autoLikeEnabled") !== "false";
  toggleAutoLikeButton.textContent = isAutoLikeOn ? "禁用自动点赞" : "启用自动点赞";
  toggleAutoLikeButton.style.cssText = `
    position: fixed; bottom: 50px; left: 10px; z-index: 1000;
    background-color: #f0f0f0; color: #000; border: 1px solid #ddd;
    padding: 5px 10px; border-radius: 5px; font-size: 12px; cursor: pointer;
  `;
  document.body.appendChild(toggleAutoLikeButton);

  toggleAutoLikeButton.addEventListener("click", () => {
    const currentEnabled = localStorage.getItem("autoLikeEnabled") !== "false";
    const newEnabled = !currentEnabled;
    localStorage.setItem("autoLikeEnabled", newEnabled ? "true" : "false");
    toggleAutoLikeButton.textContent = newEnabled ? "禁用自动点赞" : "启用自动点赞";
  });
})();
