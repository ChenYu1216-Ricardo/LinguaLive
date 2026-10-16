"use client";

import { useRef } from "react";

export default function LoginOptions() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        className="utility-button login-options-toggle"
        onClick={() => dialogRef.current?.showModal()}
      >
        登录选项
      </button>
      <dialog ref={dialogRef} className="login-dialog" aria-labelledby="login-title">
        <div className="modal-header">
          <div>
            <span className="panel-eyebrow">LinguaLive</span>
            <h2 id="login-title">登录选项</h2>
          </div>
          <button
            type="button"
            className="panel-close"
            aria-label="关闭登录选项"
            onClick={() => dialogRef.current?.close()}
          >×</button>
        </div>
        <button className="google-login-option" type="button" disabled aria-describedby="google-login-status">
          Google 登录 <span>待配置</span>
        </button>
        <p id="google-login-status" className="login-note">
          Google 登录尚未启用，网站管理员需要先完成 Google 授权配置。
        </p>
        <a className="platform-login-option" href="/signin-with-chatgpt?return_to=%2F" target="_top">
          使用 ChatGPT 账户登录
        </a>
        <p className="login-note">翻译记录目前保存在此浏览器中，登录不会自动同步到其他设备。</p>
      </dialog>
    </>
  );
}
