import { useState, type FormEvent } from "react";
import { useT } from "../i18n";

interface Props {
  invalid?: boolean;
  onSubmit: (key: string) => void;
}

export function KeyGate({ invalid, onSubmit }: Props) {
  const t = useT();
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = value.trim();
    if (k) onSubmit(k);
  };
  return (
    <form className="card gate" onSubmit={submit}>
      <h1>{t("gate.title")}</h1>
      <p className="muted">{t("gate.desc")}</p>
      <label htmlFor="api-key">{t("gate.label")}</label>
      <input
        id="api-key"
        type="password"
        autoComplete="off"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="chp_..."
      />
      {invalid && (
        <p role="alert" className="error">
          {t("gate.invalid")}
        </p>
      )}
      <button type="submit" className="primary" disabled={!value.trim()}>
        {t("gate.submit")}
      </button>
    </form>
  );
}
