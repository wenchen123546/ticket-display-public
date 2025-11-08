// public/js/superadmin-panel.js (v3.7 修改版)
 
document.addEventListener("DOMContentLoaded", () => {
    const userString = sessionStorage.getItem("currentUser");
 
    const welcomeMessage = document.getElementById("welcome-message");
    const userListContainer = document.getElementById("user-list-container");
    const userListBody = document.getElementById("user-list-body"); 
    
    const logoutButton = document.getElementById("logout-button");
 
    const newUsernameInput = document.getElementById("new-username");
    const newPasswordInput = document.getElementById("new-password");
    const newRoleInput = document.getElementById("new-role");
    const createUserButton = document.getElementById("create-user-button");
    const createError = document.getElementById("create-error");
 
    let currentUser = null;
 
    // --- 1. 驗證與 API 請求 (不變) ---
    if (!userString) {
        alert("您尚未登入或登入已逾時。");
        window.location.href = "/login.html"; 
        return;
    }
    try {
        currentUser = JSON.parse(userString);
        welcomeMessage.textContent = `歡迎， ${currentUser.username} (${currentUser.role})！`;
        if (currentUser.role !== 'superadmin') {
            alert("權限不足。您將被導向回主儀表板。");
            window.location.href = "/admin.html";
            return;
        }
    }
    catch (e) {
        console.error("解碼用戶資料失敗:", e);
        sessionStorage.removeItem("currentUser"); 
        window.location.href = "/login.html";
        return;
    }
 
    logoutButton.addEventListener("click", () => {
        if (confirm("確定要登出嗎？")) {
            sessionStorage.removeItem("currentUser");
            window.location.href = "/login.html";
        }
    });
 
    const apiRequest = async (endpoint, method = "POST", body = null) => {
        const headers = {
            "Content-Type": "application/json",
        };
        const config = { 
            method, 
            headers,
            credentials: "include"
        };
        if (body) {
            config.body = JSON.stringify(body);
        }
        const res = await fetch(endpoint, config);
        const data = await res.json();
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                sessionStorage.removeItem("currentUser"); 
                 alert("您的登入已過期，請重新登入。");
                 window.location.href = "/login.html";
            }
            throw new Error(data.error || "API 請求失敗");
        }
        return data;
    };
 
    // --- 2. 載入用戶列表 (v3.7 修改) ---
 
    const renderUserList = (users) => {
        if (!userListBody) return;
        userListBody.innerHTML = ""; 

        if (!users || users.length === 0) {
            userListBody.innerHTML = '<tr><td colspan="4">目前沒有其他用戶。</td></tr>';
            return;
        }
 
        users.forEach(user => {
            const tr = document.createElement("tr");
            const isCurrentUser = (user.username === currentUser.username);

            // 1. 用戶名稱
            const tdUser = document.createElement("td");
            tdUser.className = "user-info";
            tdUser.textContent = user.username;
            const roleSpan = document.createElement("span");
            roleSpan.textContent = user.role;
            roleSpan.className = `role-${user.role}`;
            tdUser.appendChild(roleSpan);
            tr.appendChild(tdUser);

            // 2. 角色 (下拉選單)
            const tdRole = document.createElement("td");
            const roleSelect = document.createElement("select");
            roleSelect.className = "role-select";
            roleSelect.innerHTML = `
                <option value="admin">Admin</option>
                <option value="superadmin">Super Admin</option>
            `;
            roleSelect.value = user.role;
            roleSelect.disabled = isCurrentUser; // 仍不允許修改自己的角色
            
            const feedbackSpan = document.createElement("span");
            feedbackSpan.style.marginLeft = "10px";
            tdRole.appendChild(roleSelect);
            tdRole.appendChild(feedbackSpan);
            
            roleSelect.addEventListener("change", () => {
                const oldRole = user.role;
                const newRole = roleSelect.value;
                handleUpdateRole(user.username, newRole, roleSelect, feedbackSpan, oldRole);
            });
            tr.appendChild(tdRole);

            // 3. 密碼 (行內編輯)
            const tdPassword = document.createElement("td");
            const changePwdButton = document.createElement("button");
            changePwdButton.type = "button";
            changePwdButton.className = "btn-secondary btn-small";
            changePwdButton.textContent = "改密碼";
            
            // 【v3.7 修改】 移除此行，開放修改自己密碼
            // changePwdButton.disabled = isCurrentUser; 
            
            changePwdButton.onclick = () => showPasswordUI(tdPassword, user.username);
            tdPassword.appendChild(changePwdButton);
            tr.appendChild(tdPassword);
            
            // 4. 刪除
            const tdDelete = document.createElement("td");
            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "btn-danger btn-small";
            deleteButton.textContent = "刪除";
            deleteButton.disabled = isCurrentUser; // 仍不允許刪除自己
            deleteButton.onclick = () => deleteUser(user.username);
            tdDelete.appendChild(deleteButton);
            tr.appendChild(tdDelete);

            userListBody.appendChild(tr);
        });
    };
 
    const loadUsers = async () => {
        try {
            const data = await apiRequest("/api/admin/users/list", "POST");
            renderUserList(data.users);
        } catch (err) {
            if (userListBody) {
                userListBody.innerHTML = `<p style="color: red;">載入用戶列表失敗: ${err.message}</p>`;
            }
        }
    };
 
    // --- 3. 刪除/修改用戶 (v3.3, 不變) ---
    const showPasswordUI = (cell, username) => {
        const originalButton = cell.innerHTML;
        cell.innerHTML = "";
        const input = document.createElement("input");
        input.type = "password";
        input.className = "password-input";
        input.placeholder = "新密碼 (至少 8 字元)";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn-success btn-small";
        saveBtn.textContent = "儲存";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-warn btn-small";
        cancelBtn.textContent = "取消";
        saveBtn.onclick = () => {
            const newPassword = input.value;
            if (newPassword.trim().length < 8) {
                alert("密碼長度至少需要 8 個字元。");
                return;
            }
            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            handleUpdatePassword(username, newPassword, () => {
                cell.innerHTML = originalButton;
            });
        };
        cancelBtn.onclick = () => {
            cell.innerHTML = originalButton;
        };
        cell.appendChild(input);
        cell.appendChild(saveBtn);
        cell.appendChild(cancelBtn);
    };
    const handleUpdatePassword = async (username, newPassword, onComplete) => {
        try {
            const data = await apiRequest("/api/admin/users/update-password", "POST", { username, newPassword });
            alert(data.message || `用戶 ${username} 的密碼已成功更新。`);
        } catch (err) {
            alert(`更新密碼失敗: ${err.message}`);
        } finally {
            if (onComplete) onComplete();
        }
    };
    const deleteUser = async (username) => {
        if (!confirm(`確定要永久刪除用戶 "${username}" 嗎？\n此動作無法復原！`)) {
            return;
        }
        try {
            await apiRequest("/api/admin/users/delete", "POST", { username });
            alert(`用戶 ${username} 已成功刪除。`);
            loadUsers(); 
        } catch (err) {
            alert(`刪除失敗: ${err.message}`);
        }
    };
    const handleUpdateRole = async (username, newRole, selectElement, feedbackElement, oldRole) => {
        
        selectElement.disabled = true;
        feedbackElement.innerHTML = "⏳"; // Spinner

        try {
            await apiRequest("/api/admin/users/update-role", "POST", { username, newRole });
            
            feedbackElement.innerHTML = "✅"; // Success
            loadUsers(); 
        
        } catch (err) {
            feedbackElement.innerHTML = "❌"; // Fail
            alert(`變更角色失敗: ${err.message}`);
            selectElement.value = oldRole;
        
        } finally {
            setTimeout(() => {
                feedbackElement.innerHTML = "";
                selectElement.disabled = false;
            }, 2000);
        }
    };
 
    // --- 4. 建立用戶 (v3.5, 不變) ---
    const createUserInput = () => {
        const username = newUsernameInput.value.trim().toLowerCase();
        const password = newPasswordInput.value.trim();
        const role = newRoleInput.value;
 
        if (!username || !password || !role) {
            createError.textContent = "所有欄位皆為必填。";
            return;
        }
        
        if (password.length < 8) {
            createError.textContent = "密碼長度至少需要 8 個字元。";
            return;
        }
        
        const usernameRegex = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/;
        if (!usernameRegex.test(username)) {
            createError.textContent = "帳號只能包含中英文、數字和底線(_)。";
            return;
        }
 
        createUserButton.disabled = true;
        createUserButton.textContent = "建立中...";
        createError.textContent = "";
 
        apiRequest("/api/admin/users/create", "POST", { username, password, role })
            .then(() => {
                 alert(`用戶 ${username} (${role}) 已成功建立！`);
                 newUsernameInput.value = "";
                 newPasswordInput.value = "";
                 createUserButton.disabled = false;
                 createUserButton.textContent = "建立用戶";
                 loadUsers(); 
            })
            .catch(err => {
                 createError.textContent = `建立失敗: ${err.message}`;
                 createUserButton.disabled = false;
                 createUserButton.textContent = "建立用戶";
            });
    };
     
    createUserButton.addEventListener("click", createUserInput);
 
    // --- 5. 初始載入 ---
    loadUsers();
});
