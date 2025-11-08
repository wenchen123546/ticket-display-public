// public/js/superadmin.js

document.addEventListener("DOMContentLoaded", () => {
    const usernameInput = document.getElementById("username-input");
    const passwordInput = document.getElementById("password-input");
    const loginButton = document.getElementById("login-button");
    const loginError = document.getElementById("login-error");

    const handleLogin = async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();

        if (!username || !password) {
            loginError.textContent = "帳號和密碼皆為必填。";
            return;
        }

        loginButton.disabled = true;
        loginButton.textContent = "登入中...";
        loginError.textContent = "";

        try {
            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "登入失敗");
            }

            // 登入成功！
            // 1. 儲存 JWT Token
            localStorage.setItem("jwtToken", data.token);
            
            // 2. 檢查是否為 Super Admin
            if (data.user.role !== 'superadmin') {
                throw new Error("登入成功，但您不是超級管理員。");
            }

            // 3. 轉跳到管理面板
            loginError.textContent = "✅ 登入成功，正在轉跳...";
            window.location.href = "/superadmin-panel.html"; // 轉跳到新的面板頁面

        } catch (err) {
            loginButton.disabled = false;
            loginButton.textContent = "登入";
            loginError.textContent = `❌ ${err.message}`;
        }
    };

    loginButton.addEventListener("click", handleLogin);
    passwordInput.addEventListener("keyup", (e) => {
        if (e.key === "Enter") handleLogin();
    });
    usernameInput.addEventListener("keyup", (e) => {
        if (e.key === "Enter") passwordInput.focus();
    });
});