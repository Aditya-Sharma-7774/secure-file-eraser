# secure-file-eraser
Developed a Secure File Eraser using Python to permanently delete files of any format, preventing data remanence.  Implemented multi-pass overwrite algorithms to ensure irreversible data destruction at the storage level.  Applied memory forensics concepts to validate resistance against recovery using forensic analysis tools. 
## 🚀 Features

- Permanently delete files of any type from the system  
- Implements multi-pass overwrite techniques to prevent data recovery  
- Uses memory forensics-based wiping methodologies for enhanced security  
- Works at low-level file system operations for irreversible deletion  
- Tested against common forensic recovery tools to ensure data is non-recoverable

---

## 🛠️ Technologies Used

- Python  
- OS and File Handling Modules (`os`, `shutil`)  
- Memory Forensics Concepts  
- Secure Data Overwrite Techniques (multi-pass)  

---

## 📂 Project Structure

Secure-File-Eraser/
│── eraser.py
│── README.md
│── requirements.txt (if any)

yaml
Copy code

---

## ⚙️ Installation & Usage

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/your-username/secure-file-eraser.git
cd secure-file-eraser
2️⃣ Install Dependencies
bash
Copy code
pip install -r requirements.txt
(If no dependencies, skip this step.)

3️⃣ Run the Secure File Eraser
bash
Copy code
python eraser.py
Input the full path of the file you want to securely delete.

The file will be overwritten multiple times and then permanently deleted.

🔐 Security Features
Multi-pass overwrite to prevent data remanence

Memory forensics-based deletion techniques to resist recovery

Works for files of any type and size

Prevents unauthorized recovery even using advanced forensic tools

🧪 Testing
Tested multiple file types (text, images, executables)

Verified non-recoverability using forensic analysis tools

Ensured proper error handling for invalid file paths

📌 Future Improvements
Add GUI for user-friendly interface

Support folder-level secure deletion

Implement logging and progress visualization

Integrate with secure storage systems

👨‍💻 Author
Aditya Sharma
