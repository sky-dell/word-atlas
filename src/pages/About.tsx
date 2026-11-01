import { ArrowUpRight, Database, User, Heart } from "lucide-react";
import { useAtlas } from "../atlas/context";

const BASE = import.meta.env.BASE_URL;

export function About() {
  const atlas = useAtlas();
  return (
    <div className="page about">
      <header className="about-hero">
        <img src={`${BASE}brand/og.webp`} alt="" />
        <div>
          <p className="eyebrow">关于词与远方</p>
          <h1 className="display">多懂一个词，多看一点世界。</h1>
          <p className="lede">
            词与远方把雅思阅读 8000 词整理成 {atlas.count.toLocaleString()} 个词条。每个词一幅原创插画，一句日常例句，一句雅思例句，配英美发音、常用搭配和易混提示。学会一个，就在你的星图上点亮一颗星。
          </p>
          <p className="lede">支持游客直接学习，也可免费注册账号。代码遵循 MIT，词库遵循 CC BY 4.0。</p>
          <div className="about-actions">
            <a className="btn btn-primary" href="#/account">
              <User size={18} /> 免费账户
            </a>
            <a className="btn btn-ghost" href="#/atlas">
              <Database size={18} /> 浏览词汇图鉴
            </a>
          </div>
        </div>
      </header>

      <div className="about-grid">
        <section className="panel">
          <h3 className="eyebrow">为什么记得住</h3>
          <ul className="feature-list">
            <li>
              <b>先看见。</b>每个词都有一幅画，画的就是第一句例句里发生的事。
            </li>
            <li>
              <b>再想起。</b>选义、看图补句、听音辨词、拼写，从认得走到会写。
            </li>
            <li>
              <b>刚好在快忘时重逢。</b>FSRS 是新版 Anki 用的开源记忆算法，只在你快要遗忘时安排复习。
            </li>
            <li>
              <b>分数诚实。</b>只算第一次作答。答错的词会换个题型再见一面，但不会抬高正确率。
            </li>
            <li>
              <b>进度由你掌握。</b>游客记录保存在浏览器中，可随时导出。免费注册后资料按账号隔离，可选择云同步和云端备份。
            </li>
          </ul>
        </section>

        <section className="panel">
          <h3 className="eyebrow">快捷键</h3>
          <dl className="keys">
            <div>
              <dt>
                <kbd>⌘</kbd>
                <kbd>K</kbd> 或 <kbd>/</kbd>
              </dt>
              <dd>搜索任何词</dd>
            </div>
            <div>
              <dt>
                <kbd>1</kbd>–<kbd>4</kbd>
              </dt>
              <dd>选择答案</dd>
            </div>
            <div>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>确认 / 继续</dd>
            </div>
            <div>
              <dt>
                <kbd>←</kbd> <kbd>→</kbd>
              </dt>
              <dd>词卡里切换上一个、下一个</dd>
            </div>
            <div>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>关闭弹窗</dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <h3 className="eyebrow">内容从哪里来</h3>
          <p className="muted">
            释义、例句、搭配和提示由大语言模型按统一的词典规范重新撰写；插画由图像模型按统一画风逐词绘制；发音和朗读由 ElevenLabs 合成（英音 Alice，美音 Sarah）。所有内容都经过结构和一致性的自动校验，但没有逐条人工审校。学习时请结合上下文核对释义与例句。
          </p>
          <p className="muted">词与远方不是官方雅思词表，也不承诺提分。它只想把背单词这件事，做得好看一点、扎实一点。</p>
        </section>

        <section className="panel">
          <h3 className="eyebrow">学习资料与备份</h3>
          <p className="muted">
            游客记录保存在当前浏览器，建议在「我的」中定期导出备份。免费账户登录后资料独立保存，可使用云同步和云端备份。游客身份选择不会长期记住，但不会因此删除已保存的学习资料。
          </p>
          <a className="link" href="#/me">
            管理学习数据 <ArrowUpRight size={14} />
          </a>
        </section>
      </div>
      <p className="colophon">
        <Heart size={14} /> 做给每一个在背单词的人。
      </p>
    </div>
  );
}
