// public/js/login.js (v3.0 / v3.17)
 
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
            
            // 【v3.0】 儲存伺服器回傳的 user 物件
            sessionStorage.setItem("currentUser", JSON.stringify(data.user));
            
            // 轉跳到「主儀表板」
            loginError.textContent = "✅ 登入成功，正在轉跳...";
            window.location.href = "/admin.html"; 
 
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
