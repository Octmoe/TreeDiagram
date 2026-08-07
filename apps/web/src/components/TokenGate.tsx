import { useState, type FormEvent } from 'react';
import { useApp } from '../state/app';

/** token 输入页（API_CONTRACT §2.1）：用户从 admin-token 文件粘贴，仅存 sessionStorage。 */
export function TokenGate() {
  const { login, state } = useApp();
  const [value, setValue] = useState('');

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (token) login(token);
  };

  return (
    <main className="token-gate">
      <h1>TreeDiagram</h1>
      <p>
        请粘贴管理员 token。token 位于工作区 <code>.treediagram/admin-token</code>
        文件中，仅保存到当前标签页的 sessionStorage。
      </p>
      <form onSubmit={onSubmit}>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="admin token"
          aria-label="admin token"
          autoFocus
        />
        <button type="submit">进入</button>
      </form>
      {state.statusError ? <p className="error">{state.statusError}</p> : null}
    </main>
  );
}
