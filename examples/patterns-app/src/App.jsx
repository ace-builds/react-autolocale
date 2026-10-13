import { createElement, useState } from "react";
import { LanguageSwitcher, msg } from "react-autolocale";
import { cards, links, MESSAGES, nav, specs } from "./data.js";
import faq from "./faq.json";

const FILTERS = ["All", "Tools"];            // compared below, so these must stay exactly as written
const PRODUCTS = [{ name: "Hammer", cat: "Tools" }, { name: "Poem", cat: "Books" }];

function Greeting({ name = "friend", count }) {
  return <p id="greeting">{"Hello, " + name + "!"} You have {count} messages.</p>;
}

export default function App() {
  const [filter, setFilter] = useState("All");
  const [note, setNote] = useState("Ready to go");
  const [open, setOpen] = useState(false);
  const shown = PRODUCTS.filter((p) => filter === "All" || p.cat === filter);
  const year = 2026;
  return (
    <main>
      <LanguageSwitcher />
      <nav id="nav">{nav.map((n) => <a key={n} href="#">{n}</a>)}</nav>
      <section id="cards">{cards.map((c) => <article key={c.title}><h2>{c.title}</h2><p>{c.body}</p></article>)}</section>
      <dl id="specs">{specs.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <section id="faq"><h2>{faq.title}</h2>{faq.items.map((i) => <details key={i.id}><summary>{i.question}</summary><p>{i.answer}</p></details>)}</section>
      <button id="toggle" onClick={() => setOpen(!open)} aria-label={open ? "Close menu" : "Open menu"}>{open ? "Hide details" : "Show details"}</button>
      <p id="template">{`Copyright ${year} Acme. All rights reserved.`}</p>
      <p id="concat">{"Page " + 1 + " of " + 3}</p>
      <Greeting name="Ada" count={3} />
      <p id="mixed">By continuing you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
      <p id="state">{note}</p>
      <button id="save" onClick={() => setNote(MESSAGES.saved)}>Save</button>
      <div id="el">{createElement("h3", null, "Built with createElement")}</div>
      <p id="marked">{msg("open")} / {msg("Hello {name}", { name: "Bob" })}</p>
      <div id="tabs">{FILTERS.map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>)}</div>
      <ul id="products">{shown.map((p) => <li key={p.name}>{p.name}</li>)}</ul>
      <a id="docs" href={links.docs}>Read the docs</a>
      <input id="email" placeholder="Your email address" />
    </main>
  );
}
